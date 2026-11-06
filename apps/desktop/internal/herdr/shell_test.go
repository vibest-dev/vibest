package herdr

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

type fakeHerdr struct {
	t    *testing.T
	conn net.Conn
	r    *bufio.Reader
}

func (f *fakeHerdr) send(e *enc) {
	f.t.Helper()
	if _, err := f.conn.Write(append(binary.LittleEndian.AppendUint32(nil, uint32(len(e.b))), e.b...)); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fakeHerdr) read() *dec {
	f.t.Helper()
	msg, err := readFrame(f.r)
	if err != nil {
		f.t.Fatal(err)
	}
	return &dec{b: msg}
}

func (f *fakeHerdr) control(kind, data string) {
	e := &enc{}
	e.uint(msgControl)
	e.str(kind)
	e.str(data)
	f.send(e)
}

func (f *fakeHerdr) snapshot(boot string, revision uint64) {
	b, _ := json.Marshal(map[string]any{"boot_id": boot, "revision": revision})
	f.control(snapKind, string(b))
}

func (f *fakeHerdr) surface(boot string, projection, revision uint64, text string) {
	e := &enc{}
	e.uint(msgSurface)
	e.str(boot)
	e.uint(projection)
	e.uint(revision)
	e.uint(uint64(len(text)))
	for _, r := range text {
		e.str(string(r))
		e.uint(0)
		e.uint(0)
		e.uint(0)
		e.boolean(false)
		e.none()
	}
	e.uint(uint64(len(text)))
	e.uint(1)
	e.none()
	e.uint(0)
	e.uint(0)
	e.uint(0)
	e.uint(0)
	e.none()
	e.uint(0)
	e.uint(0)
	e.uint(0)
	f.send(e)
}

func (f *fakeHerdr) patch(boot string, projection, base uint64, x int, text string) {
	e := &enc{}
	e.uint(msgPatch)
	e.str(boot)
	e.uint(projection)
	e.uint(base)
	e.uint(base + 1)
	e.uint(1)
	e.uint(uint64(x))
	e.uint(0)
	e.uint(uint64(len(text)))
	for _, r := range text {
		e.str(string(r))
		e.uint(0)
		e.uint(0)
		e.uint(0)
		e.boolean(false)
		e.none()
	}
	e.uint(0)
	e.none()
	f.send(e)
}

func (f *fakeHerdr) bell() {
	e := &enc{}
	e.uint(msgBell)
	f.send(e)
}

func (f *fakeHerdr) request() (id, method string) {
	f.t.Helper()
	d := f.read()
	if d.uint() != msgRequest {
		f.t.Fatal("not a request")
	}
	d.str()
	var req struct{ ID, Method string }
	if err := json.Unmarshal([]byte(d.str()), &req); err != nil {
		f.t.Fatal(err)
	}
	return req.ID, req.Method
}

func (f *fakeHerdr) respond(id string, chunks ...string) {
	for i, c := range chunks {
		e := &enc{}
		e.uint(msgResponse)
		e.str("b")
		e.str(id)
		e.boolean(i == len(chunks)-1)
		e.str(c)
		f.send(e)
	}
}

func connect(t *testing.T) (*Shell, *fakeHerdr, chan string, chan error) {
	client, server := net.Pipe()
	f := &fakeHerdr{t: t, conn: server, r: bufio.NewReader(server)}
	type result struct {
		s   *Shell
		err error
	}
	done := make(chan result, 1)
	go func() {
		s, err := handshake(context.Background(), client, Hello{Cols: 10, Rows: 1}, time.Second)
		done <- result{s, err}
	}()
	if d := f.read(); d.uint() != msgControl || d.str() != helloKind {
		t.Fatal("no hello")
	}
	f.control(welcomeKind, `{"generation":1,"server_version":"fake"}`)
	res := <-done
	if res.err != nil {
		t.Fatal(res.err)
	}
	s := res.s
	log := make(chan string, 16)
	s.OnSnapshot = func(sn *ShellSnapshot) { log <- "snapshot " + string(rune('0'+sn.Revision)) }
	s.OnSurface = func(sf *Surface) {
		log <- "surface " + string(rune('0'+sf.Revision)) + " " + strings.Join(sf.Frame.Text(Rect{Width: sf.Frame.W, Height: 1}), "")
	}
	s.OnEvent = func(Event) { log <- "bell" }
	ran := make(chan error, 1)
	go func() { ran <- s.Run() }()
	t.Cleanup(func() { s.Close(); server.Close() })
	return s, f, log, ran
}

func expectLog(t *testing.T, log chan string, want ...string) {
	t.Helper()
	for _, w := range want {
		select {
		case got := <-log:
			if got != w {
				t.Fatalf("got %q, want %q", got, w)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("no %q", w)
		}
	}
}

func TestSurfaceWaitsForItsSnapshot(t *testing.T) {
	_, f, log, ran := connect(t)
	f.surface("b", 2, 1, "abc")
	f.snapshot("b", 1)
	f.bell()
	expectLog(t, log, "snapshot 1", "bell")
	f.snapshot("b", 2)
	expectLog(t, log, "snapshot 2", "surface 1 abc")
	f.patch("b", 2, 1, 1, "X")
	expectLog(t, log, "surface 2 aXc")
	f.patch("b", 2, 1, 0, "Y")
	select {
	case err := <-ran:
		if err == nil || !strings.Contains(err.Error(), "patch") {
			t.Fatalf("Run ended with %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a patch of another surface was taken")
	}
}

func TestCallWaitsForActivate(t *testing.T) {
	s, f, log, _ := connect(t)
	f.snapshot("b", 1)
	expectLog(t, log, "snapshot 1")

	type result struct {
		out map[string]int
		err error
	}
	called := make(chan result, 1)
	go func() {
		var out map[string]int
		err := s.Call(context.Background(), "tab.focus", nil, &out)
		called <- result{out, err}
	}()
	activated := make(chan error, 1)
	go func() { activated <- s.Activate(context.Background()) }()

	id, method := f.request()
	if method != "client_shell.surface.set" {
		t.Fatalf("first request %s, before Activate", method)
	}
	f.respond(id, `{"id":"`+id+`",`, `"result":{}}`)
	if err := <-activated; err != nil {
		t.Fatal(err)
	}
	id, method = f.request()
	if method != "tab.focus" {
		t.Fatalf("request %s", method)
	}
	f.respond(id, `{"id":"`+id+`","result":{"n":1}}`)
	if r := <-called; r.err != nil || r.out["n"] != 1 {
		t.Fatalf("Call: %v %v", r.out, r.err)
	}

	go func() { called <- result{err: s.Call(context.Background(), "pane.focus", nil, nil)} }()
	id, _ = f.request()
	f.respond(id, `{"id":"`+id+`","error":{"code":"not_found","message":"no pane"}}`)
	var herr *Error
	if r := <-called; !errors.As(r.err, &herr) || herr.Code != "not_found" {
		t.Fatalf("error %v", r.err)
	}
}
