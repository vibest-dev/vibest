package core_test

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"vibest-desktop/internal/core"
)

type packet struct {
	channel uint32
	kind    byte
	body    []byte
}
type request struct {
	ID     uint64
	Method string
	Params json.RawMessage
}
type fixture struct {
	t        *testing.T
	conn     net.Conn
	mu       sync.Mutex
	requests chan request
	frames   chan packet
	done     chan struct{}
}

func newFixture(t *testing.T) (*core.Client, *fixture) { return newFixtureWithConn(t, nil) }
func newFixtureWithConn(t *testing.T, wrap func(net.Conn) net.Conn) (*core.Client, *fixture) {
	t.Helper()
	return newFixtureWithFeatures(t, wrap)
}
func newFixtureWithFeatures(t *testing.T, wrap func(net.Conn) net.Conn, extra ...string) (*core.Client, *fixture) {
	t.Helper()
	a, b := net.Pipe()
	f := &fixture{t: t, conn: b, requests: make(chan request, 32), frames: make(chan packet, 256), done: make(chan struct{})}
	go func() {
		defer close(f.done)
		r := bufio.NewReader(b)
		line, err := r.ReadBytes('\n')
		if err != nil {
			return
		}
		var h request
		if json.Unmarshal(line, &h) != nil || h.Method != "hello" {
			return
		}
		f.sendJSON(0, map[string]any{"jsonrpc": "2.0", "id": h.ID, "result": map[string]any{
			"generation": 1, "version": "0.1.13", "framed": true, "core": map[string]string{"id": "fixture-permanent-core", "name": "test"},
			"methods":  []string{"terminal.run", "terminal.get", "terminal.attach", "terminal.kill", "events.subscribe", "doc.get", "doc.set", "machine.list"},
			"features": append([]string{"framed", "attach", "events", "status", "shell"}, extra...),
		}}, true)
		for {
			var header [9]byte
			if _, err := io.ReadFull(r, header[:]); err != nil {
				return
			}
			p := packet{channel: binary.LittleEndian.Uint32(header[:]), kind: header[4], body: make([]byte, binary.LittleEndian.Uint32(header[5:]))}
			if _, err := io.ReadFull(r, p.body); err != nil {
				return
			}
			if p.channel == 0 {
				var q request
				if json.Unmarshal(p.body, &q) != nil {
					return
				}
				select {
				case f.requests <- q:
				case <-f.done:
					return
				}
			} else {
				f.frames <- p
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var conn net.Conn = a
	if wrap != nil {
		conn = wrap(conn)
	}
	c, err := core.Connect(ctx, conn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c.Close()
		b.Close()
		select {
		case <-f.done:
		case <-time.After(time.Second):
			t.Error("fixture reader leaked")
		}
	})
	return c, f
}
func (f *fixture) write(b []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for len(b) > 0 {
		n := min(len(b), 7)
		if _, err := f.conn.Write(b[:n]); err != nil {
			return
		}
		b = b[n:]
	}
}
func (f *fixture) send(ch uint32, kind byte, b []byte) {
	p := make([]byte, 9+len(b))
	binary.LittleEndian.PutUint32(p, ch)
	p[4] = kind
	binary.LittleEndian.PutUint32(p[5:], uint32(len(b)))
	copy(p[9:], b)
	f.write(p)
}
func (f *fixture) sendJSON(ch uint32, v any, plain bool) {
	b, _ := json.Marshal(v)
	if plain {
		f.write(append(b, '\n'))
	} else {
		f.send(ch, 0, b)
	}
}
func (f *fixture) reply(q request, v any) {
	f.sendJSON(0, map[string]any{"jsonrpc": "2.0", "id": q.ID, "result": v}, false)
}
func (f *fixture) next() request {
	f.t.Helper()
	select {
	case q := <-f.requests:
		return q
	case <-time.After(3 * time.Second):
		f.t.Fatal("request timed out")
		return request{}
	}
}
func (f *fixture) nextFrame(kind byte) packet {
	f.t.Helper()
	for {
		select {
		case p := <-f.frames:
			if p.kind == kind {
				return p
			}
		case <-time.After(3 * time.Second):
			f.t.Fatal("frame timed out")
			return packet{}
		}
	}
}
func attach(t *testing.T, c *core.Client, f *fixture, address string, ch uint32) *core.Viewer {
	t.Helper()
	go func() {
		q := f.next()
		f.reply(q, map[string]any{"channel": ch, "terminal": map[string]any{"address": address, "state": "live", "cols": 80, "rows": 24}})
	}()
	v, err := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: address, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func read(t *testing.T, r io.Reader, want string) {
	t.Helper()
	b := make([]byte, len(want))
	if _, err := io.ReadFull(r, b); err != nil {
		t.Fatal(err)
	}
	if string(b) != want {
		t.Fatalf("read %q want %q", b, want)
	}
}

func TestPublicVerticalSliceAndFocusOwnership(t *testing.T) {
	c, f := newFixture(t)
	go func() {
		q := f.next()
		if q.Method != "terminal.run" {
			t.Errorf("method %s", q.Method)
		}
		f.reply(q, map[string]any{"address": "t1", "state": "live"})
	}()
	record, err := c.Run(context.Background(), core.TerminalRunParams{CWD: core.Optional("/mock")})
	if err != nil || record.Address != "t1" {
		t.Fatal(record, err)
	}
	if record.Activity() != "unknown" || !record.NeedsCloseConfirmation() {
		t.Fatal("unreported live terminal must remain unknown and require confirmation")
	}
	a := attach(t, c, f, "t1", 1)
	b := attach(t, c, f, "t2", 2)
	f.send(1, 0, []byte("first "))
	f.send(2, 0, []byte("second"))
	f.send(1, 0, []byte("screen"))
	read(t, a, "first screen")
	read(t, b, "second")
	var keyboard core.Keyboard
	keyboard.Select(a)
	if _, ok := keyboard.Capture(); ok {
		t.Fatal("input before render")
	}
	if !keyboard.Rendered(keyboard.OwnerKey(), 80, 24, 8, 16) {
		t.Fatal("render rejected")
	}
	old, ok := keyboard.Capture()
	if !ok {
		t.Fatal("capture")
	}
	if _, err := old.Write([]byte("a")); err != nil {
		t.Fatal(err)
	}
	if p := f.nextFrame(0); p.channel != 1 || string(p.body) != "a" {
		t.Fatal(p)
	}
	keyboard.Select(b)
	keyboard.Rendered(keyboard.OwnerKey(), 80, 24, 8, 16)
	if _, err := old.Write([]byte("stale")); !errors.Is(err, core.ErrOwnership) {
		t.Fatal(err)
	}
	current, _ := keyboard.Capture()
	if _, err := current.Write([]byte("b")); err != nil {
		t.Fatal(err)
	}
	if p := f.nextFrame(0); p.channel != 2 || string(p.body) != "b" {
		t.Fatal(p)
	}
	keyboard.Select(a)
	keyboard.Rendered(keyboard.OwnerKey(), 80, 24, 8, 16)
	if _, err := old.Write([]byte("focus returned")); !errors.Is(err, core.ErrOwnership) {
		t.Fatal(err)
	}
	if err := a.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	p := f.nextFrame(3)
	if p.channel != 1 || binary.LittleEndian.Uint16(p.body) != 120 || binary.LittleEndian.Uint16(p.body[2:]) != 40 {
		t.Fatal(p)
	}
	if err := a.Focus(true); err != nil {
		t.Fatal(err)
	}
	if p := f.nextFrame(4); p.channel != 1 || len(p.body) != 1 || p.body[0] != 1 {
		t.Fatal(p)
	}
	fresh, _ := keyboard.Capture()
	f.send(1, 2, []byte(`{"reason":"holder_lost"}`))
	if _, err := a.Read(make([]byte, 1)); err != io.EOF {
		t.Fatal(err)
	}
	if _, err := fresh.Write([]byte("closed")); !errors.Is(err, core.ErrOwnership) {
		t.Fatal(err)
	}
	replacement := attach(t, c, f, "t1", 3)
	keyboard.Select(replacement)
	keyboard.Rendered(keyboard.OwnerKey(), 80, 24, 8, 16)
	if _, err := fresh.Write([]byte("replacement")); !errors.Is(err, core.ErrOwnership) {
		t.Fatal(err)
	}
	c.Close()
	if _, err := current.Write([]byte("disconnected")); err == nil {
		t.Fatal("write after close")
	}
}

func TestAttachAcceptsFirstPaintBeforeRPCReply(t *testing.T) {
	c, f := newFixture(t)
	go func() {
		q := f.next()
		f.send(7, 0, []byte("first paint"))
		f.reply(q, map[string]any{"channel": 7, "terminal": map[string]any{"address": "t1", "state": "live", "cols": 80, "rows": 24}})
	}()
	v, err := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: "t1", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	read(t, v, "first paint")
}

func TestStalledStreamDoesNotBlockControlOrOtherStream(t *testing.T) {
	c, f := newFixture(t)
	a := attach(t, c, f, "t1", 1)
	b := attach(t, c, f, "t2", 2)
	f.send(1, 0, make([]byte, 256<<10))
	f.send(2, 0, []byte("live"))
	read(t, b, "live")
	go func() { q := f.next(); f.reply(q, map[string]any{"machines": []any{}}) }()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := c.Machines(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	f.send(1, 0, []byte("already in flight"))
	f.send(1, 2, nil)
	go func() { q := f.next(); f.reply(q, map[string]any{"machines": []any{}}) }()
	if _, err := c.Machines(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestCanceledAttachDetachesLateChannel(t *testing.T) {
	c, f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := c.Attach(ctx, core.TerminalAttachParams{Terminal: "t1", Cols: 80, Rows: 24})
		result <- err
	}()
	q := f.next()
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	f.reply(q, map[string]any{"channel": 1, "terminal": map[string]string{"address": "t1"}})
	if p := f.nextFrame(2); p.channel != 1 {
		t.Fatal(p)
	}
	f.send(1, 2, nil)
}

func TestSubscribeFragmentedLinesAndCredit(t *testing.T) {
	c, f := newFixture(t)
	go func() { q := f.next(); f.reply(q, map[string]any{"channel": 1, "seq": 7, "terminals": []any{}}) }()
	sub, err := c.Subscribe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if sub.Snapshot.Seq != 7 {
		t.Fatal(sub.Snapshot)
	}
	line := `{"jsonrpc":"2.0","method":"event","params":{"seq":8,"type":"doc","data":{"name":"reherdr","version":2}}}` + "\n"
	f.send(1, 0, []byte(line[:23]))
	f.send(1, 0, []byte(line[23:]))
	e, err := sub.Next()
	if err != nil || e.Method != "event" || e.Params.Type != "doc" || e.Params.Seq != 8 {
		t.Fatal(e, err)
	}
	n := 0
	for n < len(line) {
		p := f.nextFrame(1)
		n += int(binary.LittleEndian.Uint32(p.body))
	}
	if n != len(line) {
		t.Fatal(n)
	}
}

func TestMalformedAndOverCreditFramesCloseConnection(t *testing.T) {
	for _, test := range []string{"oversize", "overcredit", "unknown"} {
		t.Run(test, func(t *testing.T) {
			c, f := newFixture(t)
			switch test {
			case "oversize":
				h := make([]byte, 9)
				binary.LittleEndian.PutUint32(h[5:], 16<<20+1)
				f.write(h)
			case "overcredit":
				attach(t, c, f, "t1", 1)
				f.send(1, 0, make([]byte, 256<<10+1))
			case "unknown":
				f.send(9, 0, []byte("unowned"))
			}
			select {
			case <-c.Done():
				if c.Err() == nil {
					t.Fatal("missing error")
				}
			case <-time.After(time.Second):
				t.Fatal("not closed")
			}
		})
	}
}

func TestEndpointRulesAreExplicitAndIsolated(t *testing.T) {
	o := core.EndpointOptions{Home: "/home/test", Session: " demo ", UID: 501}
	p, err := o.Path()
	if err != nil || p != "/home/test/.local/state/herdr-core/demo/demo.sock" {
		t.Fatal(p, err)
	}
	o.RuntimeDir = "/run/test"
	p, err = o.Path()
	if err != nil || p != "/run/test/herdr-core/demo.sock" {
		t.Fatal(p, err)
	}
	o.ConfigSocket = "/tmp/config.sock"
	o.Socket = "/tmp/explicit.sock"
	p, err = o.Path()
	if err != nil || p != o.Socket {
		t.Fatal(p, err)
	}
	for _, session := range []string{"..", "a/b", "a\\b", "a\nb"} {
		o.Session = session
		if _, err = o.Path(); err == nil {
			t.Fatalf("accepted %q", session)
		}
	}
	o.Session = "default"
	o.Socket = "/tmp/" + strings.Repeat("x", 120)
	if _, err = o.Path(); err == nil {
		t.Fatal("long path")
	}
}
