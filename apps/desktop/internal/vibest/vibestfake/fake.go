package vibestfake

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
)

type Script []json.RawMessage

var Hangup = json.RawMessage(`{"vibestfake":"hangup"}`)

func ContractDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "..", "packages", "protocol", "contract")
}

func Load(t testing.TB, name string) Script {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(ContractDir(), "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	var script Script
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		script = append(script, json.RawMessage(line))
	}
	return script
}

func Concat(scripts ...Script) Script {
	var all Script
	for _, s := range scripts {
		all = append(all, s...)
	}
	return all
}

type Server struct {
	Path     string
	listener net.Listener
	wg       sync.WaitGroup
	mu       sync.Mutex
	conns    []net.Conn
}

func Serve(t testing.TB, scripts ...Script) *Server {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "vibestfake")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "vibest.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Path: path, listener: listener}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for _, script := range scripts {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.conns = append(s.conns, conn)
			s.mu.Unlock()
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				replay(t, conn, script)
			}()
		}
	}()
	t.Cleanup(func() {
		s.Close()
		s.wg.Wait()
		os.RemoveAll(dir)
	})
	return s
}

func (s *Server) Close() {
	s.listener.Close()
	s.DropConnections()
}

func (s *Server) DropConnections() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.conns {
		c.Close()
	}
	s.conns = nil
}

func isClientLine(line json.RawMessage) bool {
	var m struct {
		Method string `json:"method"`
	}
	return json.Unmarshal(line, &m) == nil && m.Method != ""
}

func replay(t testing.TB, conn net.Conn, script Script) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	ids := map[float64]float64{}
	for _, line := range script {
		if bytes.Equal(line, Hangup) {
			return
		}
		var want map[string]any
		if err := json.Unmarshal(line, &want); err != nil {
			t.Errorf("vibestfake: fixture line %s: %v", line, err)
			return
		}
		if isClientLine(line) {
			got, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var have map[string]any
			if err := json.Unmarshal(got, &have); err != nil {
				t.Errorf("vibestfake: client sent %q: %v", got, err)
				return
			}
			if id, ok := want["id"].(float64); ok {
				if actual, ok := have["id"].(float64); ok {
					ids[id] = actual
				}
			}
			mapIDs(want, ids)
			if !reflect.DeepEqual(want, have) {
				t.Errorf("vibestfake: client sent\n%s\nwant\n%s", strings.TrimSpace(string(got)), line)
				return
			}
			continue
		}
		mapIDs(want, ids)
		out, _ := json.Marshal(want)
		if _, err := conn.Write(append(out, '\n')); err != nil {
			return
		}
	}
	_, _ = reader.WriteTo(discard{})
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func mapIDs(m map[string]any, ids map[float64]float64) {
	if id, ok := m["id"].(float64); ok {
		if actual, ok := ids[id]; ok {
			m["id"] = actual
		}
	}
	if params, ok := m["params"].(map[string]any); ok {
		if id, ok := params["requestId"].(float64); ok {
			if actual, ok := ids[id]; ok {
				params["requestId"] = actual
			}
		}
	}
}
