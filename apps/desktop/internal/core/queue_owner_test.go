//go:build corequeue

package core_test

import (
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/core"
)

type queueBarrier struct {
	entered, release chan struct{}
	once             sync.Once
}

func (b *queueBarrier) wait(p []byte) bool {
	if string(p) != "gate" {
		return false
	}
	b.once.Do(func() { close(b.entered) })
	<-b.release
	return true
}

type queueConn struct {
	viewer   *core.Viewer
	keyboard *core.Keyboard
	barrier  *queueBarrier
}

func (c queueConn) Read(p []byte) (int, error) { return c.viewer.Read(p) }
func (c queueConn) Close() error               { return c.viewer.Close() }

func (c queueConn) Write(p []byte) (int, error) {
	if c.barrier.wait(p) {
		return len(p), nil
	}
	input, ok := c.keyboard.CaptureFor(c.viewer)
	if !ok {
		return len(p), nil
	}
	return input.Write(p)
}

type queuedLease struct {
	input   core.Input
	barrier *queueBarrier
}

func (w queuedLease) Write(p []byte) (int, error) {
	if w.barrier.wait(p) {
		return len(p), nil
	}
	n, err := w.input.Write(p)
	if errors.Is(err, core.ErrOwnership) || errors.Is(err, core.ErrClosed) {
		return len(p), nil
	}
	return n, err
}

func TestToolkitQueueOwnerBeforeEnqueue(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified VT library required; no download")
	}
	c, f := newFixture(t)
	v := attach(t, c, f, "t1", 1)
	var keyboard core.Keyboard
	barrier := &queueBarrier{entered: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(barrier.release) })
	opts := terminal.Options{Conn: queueConn{v, &keyboard, barrier}, NoClipboardWrite: true}
	hook := reflect.ValueOf(&opts).Elem().FieldByName("CaptureInput")
	if hook.IsValid() {
		hook.Set(reflect.ValueOf(func() io.Writer {
			input, ok := keyboard.CaptureFor(v)
			if !ok {
				return nil
			}
			return queuedLease{input, barrier}
		}))
	} else {
		t.Log("unpatched toolkit: exercising Conn.Write-only admission")
	}
	vt, err := terminal.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	defer vt.Close()
	keyboard.Select(v)
	tt := ui.NewTester(func(c *ui.Context) { terminal.View(c, vt).Fill().AutoFocus() }, 400, 200)
	f.send(1, 0, []byte("retained VT state\r\n"))
	deadline := time.Now().Add(3 * time.Second)
	for !strings.Contains(vt.Text(), "retained VT state") {
		if time.Now().After(deadline) {
			t.Fatal("output not parsed")
		}
		time.Sleep(time.Millisecond)
	}
	tt.Frame()
	cols, rows := vt.Size()
	keyboard.Rendered(keyboard.OwnerKey(), cols, rows, 8, 16)
	vt.Send([]byte("gate"))
	select {
	case <-barrier.entered:
	case <-time.After(time.Second):
		t.Fatal("writer did not reach inert barrier")
	}
	tt.Type("stale-before-blur")
	keyboard.Select(nil)
	keyboard.Select(v)
	tt.Frame()
	keyboard.Rendered(keyboard.OwnerKey(), cols, rows, 8, 16)
	vt.Send([]byte("current-1"))
	vt.Send([]byte("current-2"))
	release.Do(func() { close(barrier.release) })
	for _, want := range []string{"current-1", "current-2"} {
		p := f.nextFrame(0)
		if p.channel != 1 || string(p.body) != want {
			t.Fatalf("queue delivered %q on channel %d; want %q on channel 1 (stale bytes must not revive)", p.body, p.channel, want)
		}
	}
	if !strings.Contains(vt.Text(), "retained VT state") {
		t.Fatal("focus change destroyed VT state")
	}
}
