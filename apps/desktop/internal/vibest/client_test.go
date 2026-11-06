package vibest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"vibest-desktop/internal/vibest/vibestfake"
)

func dial(t *testing.T, scripts ...vibestfake.Script) *Client {
	t.Helper()
	server := vibestfake.Serve(t, scripts...)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := Dial(ctx, server.Path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func timeout(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestProtocolMatchesTheContract(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(vibestfake.ContractDir(), "rpc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Protocol int `json:"protocol"`
		Methods  map[string]struct {
			Stream bool `json:"stream"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.Protocol != Protocol {
		t.Fatalf("contract protocol %d, client %d", contract.Protocol, Protocol)
	}
	for method, stream := range map[string]bool{"Ping": false, "Project.Open": false, "Launch": false, "Remove": false} {
		m, ok := contract.Methods[method]
		if !ok || m.Stream != stream {
			t.Errorf("%s: in contract %v, stream %v, want stream %v", method, ok, m.Stream, stream)
		}
	}
}

func strictDecode(t *testing.T, raw json.RawMessage, into any) {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		t.Errorf("%s: %v", raw, err)
	}
}

func TestEveryFixtureResultDecodesStrictly(t *testing.T) {
	types := map[string]func() any{
		"ping.ndjson":         func() any { return &PingResult{} },
		"project-open.ndjson": func() any { return &OpenResult{} },
		"launch.ndjson":       func() any { return &LaunchResult{} },
		"remove.ndjson":       func() any { return &RemoveResult{} },
	}
	for file, into := range types {
		for _, line := range vibestfake.Load(t, file) {
			var m inbound
			if err := json.Unmarshal(line, &m); err != nil {
				t.Fatal(err)
			}
			if m.Method != "" || m.Error != nil {
				continue
			}
			strictDecode(t, m.Result, into())
		}
	}
}

func TestPingSendsTheRecordedRequest(t *testing.T) {
	c := dial(t, vibestfake.Load(t, "ping.ndjson"))
	got, err := c.Ping(timeout(t))
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != "0.0.0-fixture" || !got.Capabilities["requests"] {
		t.Fatalf("%+v", got)
	}
}

func TestPingRefusesAnotherProtocol(t *testing.T) {
	c := dial(t, vibestfake.Script{
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"Ping","params":null,"headers":[]}`),
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"protocol":6,"version":"9.0.0"}}`),
	})
	_, err := c.Ping(timeout(t))
	var mismatch *ProtocolError
	if !errors.As(err, &mismatch) || mismatch.Daemon != 6 || mismatch.Error() != "vibestd 9.0.0 speaks protocol 6, this app speaks 5: update the desktop app" {
		t.Fatalf("%v", err)
	}
}

func TestProjectOpenAnswersAndNotInRepository(t *testing.T) {
	c := dial(t, vibestfake.Load(t, "project-open.ndjson"))
	ctx := timeout(t)
	for range 2 {
		got, err := c.OpenProject(ctx, "/fixture/repo", OpenParams{})
		if err != nil || got.ProjectID != "00000000-0000-4000-8000-000000000001" || got.Directory != "/fixture/repo" {
			t.Fatalf("%+v %v", got, err)
		}
	}
	_, err := c.OpenProject(ctx, "/fixture/plain", OpenParams{})
	var failure *Error
	if !errors.As(err, &failure) || failure.Tag != "NotInRepository" {
		t.Fatalf("%v", err)
	}
}

func TestLaunchSendsTheRecordedRequest(t *testing.T) {
	c := dial(t, vibestfake.Load(t, "launch.ndjson"))
	got, err := c.Launch(timeout(t), "/fixture/repo", LaunchParams{Argv: []string{"vibest"}})
	if err != nil || got.Terminal != "ws1:p2" || got.Runtime != "herdr" {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestRemoveAnswersAndNoSuchSession(t *testing.T) {
	c := dial(t, vibestfake.Load(t, "remove.ndjson"))
	ctx := timeout(t)
	got, err := c.Remove(ctx, RemoveParams{ID: "00000000-0000-4000-8000-000000000001"})
	if err != nil || got == nil || got.Worktree != "removed" {
		t.Fatalf("%+v %v", got, err)
	}
	_, err = c.Remove(ctx, RemoveParams{ID: "0000000000"})
	var failure *Error
	if !errors.As(err, &failure) || failure.Tag != "NoSuchSession" || failure.Error() != "vibest: no session 0000000000" {
		t.Fatalf("%v", err)
	}
}

func TestProtocolRejectedCarriesItsMessageAndAction(t *testing.T) {
	script := vibestfake.Load(t, "protocol-rejected.ndjson")
	var m inbound
	if err := json.Unmarshal(script[1], &m); err != nil || m.Error == nil {
		t.Fatalf("%v", err)
	}
	failure := m.Error.decode()
	mismatch, ok := failure.Mismatch()
	if !ok || mismatch.Action != "vibest update" || failure.Message != mismatch.Message || mismatch.Protocol != 5 {
		t.Fatalf("%+v %+v", failure, mismatch)
	}
}

func TestStreamAcksEachChunkAndInterruptsOnClose(t *testing.T) {
	c := dial(t, vibestfake.Script{
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"Watch","params":null,"headers":[["vibest-protocol","5"],["vibest-caller","cli"],["vibest-repository","/"]]}`),
		json.RawMessage(`{"jsonrpc":"2.0","chunk":true,"id":1,"result":[1,2]}`),
		json.RawMessage(`{"jsonrpc":"2.0","method":"@effect/rpc/Ack","params":{"requestId":1}}`),
		json.RawMessage(`{"jsonrpc":"2.0","chunk":true,"id":1,"result":[3]}`),
		json.RawMessage(`{"jsonrpc":"2.0","method":"@effect/rpc/Ack","params":{"requestId":1}}`),
		json.RawMessage(`{"jsonrpc":"2.0","method":"@effect/rpc/Interrupt","params":{"requestId":1}}`),
		json.RawMessage(`{"jsonrpc":"2.0","id":2,"method":"Ping","params":null,"headers":[]}`),
		json.RawMessage(`{"jsonrpc":"2.0","id":2,"result":{"protocol":5,"version":"v"}}`),
	})
	ctx := timeout(t)
	s, err := c.Stream("Watch", "/", nil)
	if err != nil {
		t.Fatal(err)
	}
	var values []string
	for range 2 {
		chunk, err := s.Next(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range chunk {
			values = append(values, string(v))
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Ping(ctx); err != nil {
		t.Fatalf("the connection stays usable after an interrupt: %v", err)
	}
	if want := []string{"1", "2", "3"}; !equal(values, want) {
		t.Fatalf("%v", values)
	}
}

func TestALostConnectionFailsPendingCalls(t *testing.T) {
	c := dial(t, vibestfake.Script{
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"Ping","params":null,"headers":[]}`),
		vibestfake.Hangup,
	})
	_, err := c.Ping(timeout(t))
	if !errors.Is(err, ErrClosed) {
		t.Fatalf("%v", err)
	}
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("Done not closed")
	}
}

func TestSocketPathFollowsVibestHome(t *testing.T) {
	t.Setenv("VIBEST_HOME", "/x/home")
	if got := SocketPath(); got != "/x/home/vibest.sock" {
		t.Fatal(got)
	}
	t.Setenv("VIBEST_HOME", "")
	t.Setenv("HOME", "/u")
	if got := SocketPath(); got != "/u/.vibest/vibest.sock" {
		t.Fatal(got)
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
