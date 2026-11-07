//go:build corevt

package core_test

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"vibest-desktop/internal/core"
	"vibest-desktop/internal/coreview"

	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

func TestCoreVTKeepsRendererScrollAndCompositionOwnership(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified VT library required")
	}
	c, f := newFixture(t)
	v := attach(t, c, f, "t1", 1)
	var k core.Keyboard
	view, err := coreview.New(v, &k, terminal.Options{NoClipboardWrite: true})
	if err != nil {
		t.Fatal(err)
	}
	defer view.Close()
	original := view.VT
	view.Select()
	tt := ui.NewTester(func(c *ui.Context) { view.View(c).Fill().AutoFocus() }, 400, 200)
	var output strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&output, "line %03d\r\n", i)
	}
	f.send(1, 0, []byte("[?9001l"+output.String()))
	deadline := time.Now().Add(time.Second)
	for !strings.Contains(view.VT.Text(), "line 099") {
		if time.Now().After(deadline) {
			t.Fatal("VT output not parsed")
		}
		time.Sleep(time.Millisecond)
	}
	tt.Frame()
	bottom := bytes.Clone(tt.Image().Pix)
	tt.Wheel(100, 100, 0, -80)
	scrolled := bytes.Clone(tt.Image().Pix)
	if bytes.Equal(bottom, scrolled) {
		t.Fatal("fixture did not scroll")
	}
	text := view.VT.Text()
	old, ok := k.CaptureFor(v)
	if !ok {
		t.Fatal("not rendered")
	}
	tt.Compose("pending", 3)
	view.CancelComposition()
	tt.Frame()
	if old.Valid() {
		t.Fatal("composition cancellation kept old lease")
	}
	if !bytes.Equal(scrolled, tt.Image().Pix) {
		t.Fatal("composition cancellation changed the scrolled view")
	}
	view.Cancel()
	view.Select()
	tt.Frame()
	if view.VT != original || view.VT.Text() != text || !bytes.Equal(scrolled, tt.Image().Pix) {
		t.Fatal("focus loss recreated or reset VT/scroll state")
	}
	select {
	case q := <-f.requests:
		t.Fatalf("unexpected reattach/restore call: %s", q.Method)
	default:
	}
	tt.SetSize(1, 1)
	if _, ok := k.CaptureFor(v); ok {
		t.Fatal("clipped grid retained rendered readiness")
	}
	tt.SetSize(400, 200)
	if _, ok := k.CaptureFor(v); !ok {
		t.Fatal("fitted repaint did not restore readiness")
	}
}

func TestCoreVTDisplayInputPasteAndTwoTerminalFocus(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("set MYGO_GHOSTTY_VT to the checksum-verified MyGo libghostty-vt library; no automatic download")
	}
	c, f := newFixture(t)
	a := attach(t, c, f, "t1", 1)
	b := attach(t, c, f, "t2", 2)
	var keyboard core.Keyboard
	one, err := coreview.New(a, &keyboard, terminal.Options{NoClipboardWrite: true})
	if err != nil {
		t.Fatal(err)
	}
	defer one.Close()
	two, err := coreview.New(b, &keyboard, terminal.Options{NoClipboardWrite: true})
	if err != nil {
		t.Fatal(err)
	}
	defer two.Close()
	selected := one
	selected.Select()
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Row(c).Fill().Children(func() {
			e := one.View(c).Grow(1).FillHeight().Label("one")
			if selected == one {
				e.Focus()
			}
			e = two.View(c).Grow(1).FillHeight().Label("two")
			if selected == two {
				e.Focus()
			}
		})
	}, 800, 240)
	if _, ok := keyboard.CaptureFor(a); ok {
		t.Fatal("empty renderer admitted input before parsed output")
	}
	f.send(1, 0, []byte("\x1b[?9001l\x1b[31mfirst 世界\x1b[0m\r\n\x1b[?2004h\x1b[?1h"))
	wait := func(what string, condition func() bool) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for !condition() {
			if time.Now().After(deadline) {
				t.Fatal("timeout: " + what)
			}
			tt.Frame()
			time.Sleep(time.Millisecond)
		}
	}
	wait("first VT parsed", func() bool { return strings.Contains(one.VT.Text(), "first 世界") })
	one.Cancel()
	selected = two
	two.Select()
	tt.Frame()
	if _, ok := keyboard.CaptureFor(b); ok {
		t.Fatal("sibling paint established readiness for an empty selected terminal")
	}
	two.Cancel()
	selected = one
	one.Select()
	f.send(2, 0, []byte("\x1b[?9001lsecond terminal\r\n"))
	wait("VT parsed both streams", func() bool {
		return strings.Contains(one.VT.Text(), "first 世界") && strings.Contains(two.VT.Text(), "second terminal")
	})
	tt.Frame()
	if _, ok := keyboard.CaptureFor(a); !ok {
		t.Fatal("paint did not establish readiness")
	}
	if image := tt.Image(); image == nil || image.Bounds().Dx() != 800 {
		t.Fatal("software render missing")
	}
	tt.Type("abc")
	p := f.nextFrame(0)
	if p.channel != 1 || string(p.body) != "abc" {
		t.Fatalf("typing destination/payload: %+v", p)
	}
	tt.Key(0, ui.KeyUp)
	p = f.nextFrame(0)
	if p.channel != 1 || string(p.body) != "\x1bOA" {
		t.Fatalf("mode-aware cursor encoding: %+v", p)
	}
	one.VT.Paste("two lines\ntext")
	p = f.nextFrame(0)
	if p.channel != 1 || string(p.body) != "\x1b[200~two lines\ntext\x1b[201~" {
		t.Fatalf("bracketed paste: %+v", p)
	}
	old, _ := keyboard.CaptureFor(a)
	tt.Compose("not committed", 3)
	one.Cancel()
	selected = two
	two.Select()
	tt.Frame()
	tt.Type("dest2")
	p = f.nextFrame(0)
	if p.channel != 2 || string(p.body) != "dest2" {
		t.Fatalf("two-terminal destination: %+v", p)
	}
	if _, err = old.Write([]byte("stale")); err == nil {
		t.Fatal("old focus capture revived")
	}
	two.Cancel()
	selected = one
	one.Select()
	tt.Frame()
	if _, err = old.Write([]byte("stale again")); err == nil {
		t.Fatal("old capture revived on return")
	}
	tt.Type("fresh")
	p = f.nextFrame(0)
	if p.channel != 1 || string(p.body) != "fresh" {
		t.Fatalf("returned destination: %+v", p)
	}
	f.send(1, 0, []byte("\x1b[?90"))
	f.send(1, 0, []byte("01h"))
	wait("unsupported mode refusal", func() bool { return one.InputError() != nil })
	tt.Type("must not encode Unix text for ConPTY")
	for {
		select {
		case p := <-f.frames:
			if p.kind == 0 {
				t.Fatal("input bypassed unsupported mode refusal")
			}
		default:
			return
		}
	}
}
