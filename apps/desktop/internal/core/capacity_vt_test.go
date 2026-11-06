//go:build corevt

package core_test

import (
	"context"
	"errors"
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/coreview"
)

type vtWriteGate struct {
	net.Conn
	armed            atomic.Bool
	entered, release chan struct{}
}

func (g *vtWriteGate) Write(p []byte) (int, error) {
	if g.armed.CompareAndSwap(true, false) {
		close(g.entered)
		<-g.release
	}
	return g.Conn.Write(p)
}
func TestCoreBusyIsRecoverableThroughActualToolkitQueue(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified VT library required")
	}
	var gate *vtWriteGate
	c, f := newFixtureWithConn(t, func(conn net.Conn) net.Conn {
		gate = &vtWriteGate{Conn: conn, entered: make(chan struct{}), release: make(chan struct{})}
		return gate
	})
	var released sync.Once
	defer released.Do(func() { close(gate.release) })
	v := attach(t, c, f, "t1", 1)
	var k core.Keyboard
	refused := make(chan error, 2)
	view, err := coreview.New(v, &k, terminal.Options{NoClipboardWrite: true, OnInputError: func(err error) { refused <- err }})
	if err != nil {
		t.Fatal(err)
	}
	defer view.Close()
	view.Select()
	tt := ui.NewTester(func(c *ui.Context) { view.View(c).Fill().AutoFocus() }, 400, 200)
	f.send(1, 0, []byte("\x1b[?9001lready"))
	until := time.Now().Add(time.Second)
	for {
		tt.Frame()
		if _, ready := k.CaptureFor(v); ready {
			break
		}
		if time.Now().After(until) {
			t.Fatal("not ready")
		}
		time.Sleep(time.Millisecond)
	}
	go func() {
		for {
			select {
			case q := <-f.requests:
				f.reply(q, map[string]any{"machines": []any{}})
			case <-f.done:
				return
			}
		}
	}()
	gate.armed.Store(true)
	blocked := make(chan error, 1)
	go func() { _, err := c.Machines(context.Background()); blocked <- err }()
	select {
	case <-gate.entered:
	case <-time.After(time.Second):
		t.Fatal("write not blocked")
	}
	results := make(chan error, 40)
	for i := 0; i < 40; i++ {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			results <- c.Call(ctx, "terminal.get", map[string]string{"body": strings.Repeat("x", 32<<10)}, nil)
		}()
	}
	select {
	case err := <-results:
		if !errors.Is(err, core.ErrBusy) {
			t.Fatalf("queue not full: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("capacity not reached")
	}
	view.VT.Send(make([]byte, 64<<10))
	select {
	case err := <-refused:
		if !errors.Is(err, terminal.ErrInputFull) {
			t.Fatalf("busy was fatal or hidden: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Core refusal not exposed")
	}
	released.Do(func() { close(gate.release) })
	select {
	case err := <-blocked:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked control did not finish")
	}
	for i := 1; i < 40; i++ {
		select {
		case err := <-results:
			if err != nil && !errors.Is(err, core.ErrBusy) {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("queued call did not finish")
		}
	}
	tt.Type("after busy")
	p := f.nextFrame(0)
	if p.channel != 1 || string(p.body) != "after busy" {
		t.Fatalf("input poisoned or replayed: %+v", p)
	}
}
