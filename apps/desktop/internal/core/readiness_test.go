//go:build corevt

package core_test

import (
	"errors"
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
	"os"
	"strings"
	"testing"
	"time"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/coreview"
)

func TestInitialModeMustBeParsedAndPainted(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified VT library required")
	}
	for _, mode := range []string{"l", "h"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			v := attach(t, c, f, "t1", 1)
			var k core.Keyboard
			parsed := make(chan struct{}, 8)
			view, err := coreview.New(v, &k, terminal.Options{NoClipboardWrite: true, OnOutput: func([]byte) { parsed <- struct{}{} }})
			if err != nil {
				t.Fatal(err)
			}
			defer view.Close()
			view.Select()
			tt := ui.NewTester(func(c *ui.Context) { view.View(c).Fill().AutoFocus() }, 400, 200)
			send := func(s string) {
				t.Helper()
				f.send(1, 0, []byte(s))
				select {
				case <-parsed:
				case <-time.After(time.Second):
					t.Fatal("not parsed")
				}
			}
			closed := func() {
				t.Helper()
				tt.Frame()
				if _, ok := k.CaptureFor(v); ok {
					t.Fatal("unclassified or held paint admitted input")
				}
			}
			send("painted before marker")
			closed()
			send("\x1b[?900")
			closed()
			send("1" + mode + "\x1b[?2026hheld")
			closed()
			send("\x1b[?2026l")
			tt.Frame()
			_, ready := k.CaptureFor(v)
			if ready != (mode == "l") {
				t.Fatalf("ready %v for mode %s", ready, mode)
			}
			if (view.InputError() != nil) != (mode == "h") {
				t.Fatal("unsupported mode refusal missing")
			}
		})
	}
}

func TestCoreVTOverflowIsVisibleAndSubsequentTypingWorks(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified VT library required")
	}
	c, f := newFixture(t)
	v := attach(t, c, f, "t1", 1)
	var k core.Keyboard
	refused := make(chan error, 4)
	view, err := coreview.New(v, &k, terminal.Options{NoClipboardWrite: true, OnInputError: func(err error) { refused <- err }})
	if err != nil {
		t.Fatal(err)
	}
	defer view.Close()
	view.Select()
	tt := ui.NewTester(func(c *ui.Context) { view.View(c).Fill().AutoFocus() }, 400, 200)
	f.send(1, 0, []byte("\x1b[?9001lready"))
	until := time.Now().Add(time.Second)
	for !strings.Contains(view.VT.Text(), "ready") {
		if time.Now().After(until) {
			t.Fatal("not parsed")
		}
		time.Sleep(time.Millisecond)
	}
	tt.Frame()
	for _, size := range []int{1 << 20, (1 << 20) + 1} {
		view.VT.Send(make([]byte, size))
		select {
		case err := <-refused:
			if !errors.Is(err, terminal.ErrInputFull) {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("silent capacity refusal")
		}
		tt.Type("still usable")
		got := f.nextFrame(0)
		if got.channel != 1 || string(got.body) != "still usable" {
			t.Fatalf("bad subsequent input: %+v", got)
		}
	}
}
