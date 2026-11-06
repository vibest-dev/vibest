package app

import (
	"bytes"
	"errors"
	"math"
	"testing"
	"vibest-desktop/internal/core"
)

func TestTooSmallCoreViewTakesNoInput(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := readyCorePane(t, a, tt, "a")
	tt.SetSize(80, 60)
	tt.Frame()
	tt.Frame()
	if v.InputReady() {
		t.Fatal("undrawn view has input ownership")
	}
	tt.Type("not drawn")
	v.VT.Paste("not drawn either")
	select {
	case p := <-f.inputs:
		t.Fatalf("undrawn view sent %q", p.body)
	default:
	}
	if r, active := tt.TextCaret(); active && r.W > 0 && r.H > 0 {
		t.Fatalf("undrawn view retained caret %v", r)
	}
}
func TestInputMapsActualPaintedVTCells(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[?1000h\x1b[?1006h")
	for _, width := range []int{1280, 1120} {
		tt.SetSize(width, 800)
		readyCorePane(t, a, tt, "a")
		r := vtCell(t, tt, v, "a", 5, 3)
		tt.ClickAt(float32(r.Min.X+1), float32(r.Min.Y+1))
		wantCoreInput(t, f, "\x1b[<0;6;4M")
		wantCoreInput(t, f, "\x1b[<0;6;4m")
	}
}
func TestInputSkipsAClosedCoreViewer(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	coreAppAct(a, func() { a.ShowPane("b") })
	v := readyCorePane(t, a, tt, "b")
	capture, ok := a.coreKeyboard.CaptureFor(v.Viewer)
	if !ok {
		t.Fatal("no original painted owner")
	}
	coreAppAct(a, func() { a.coreEdit(func(l *core.Layout) error { return l.RemovePane("b") }) })
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("b") == nil })
	if n, err := capture.Write([]byte("stale")); n != 0 || !errors.Is(err, core.ErrOwnership) {
		t.Fatalf("closed viewer admitted %d/%v", n, err)
	}
	readyCorePane(t, a, tt, "a")
	tt.Type("current")
	wantCoreInput(t, f, "current")
}
func TestDragDoesNotMoveAnotherTabsSplit(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	coreAppAct(a, func() {
		a.coreEdit(func(l *core.Layout) error {
			p := core.NewPane(core.TerminalRef{CoreID: "app-fixture", Address: "extra"})
			p.ID = "extra"
			return l.SplitPane("c", "right", p)
		})
	})
	awaitCoreApp(t, a, func() bool { return a.coreState.Version == 1 })
	f.mu.Lock()
	f.terminals["extra"] = core.Terminal{Address: "extra", Cols: 80, Rows: 24}
	f.mu.Unlock()
	tt.Frame()
	g := find(t, tt, "core-split-grip")
	tt.Press(g.X+g.W/2, g.Y+100)
	tt.Move(g.X+g.W/2+40, g.Y+100)
	coreAppAct(a, func() { a.SelectTab("t2") })
	tt.Frame()
	tt.Release(g.X+g.W/2+80, g.Y+100)
	tt.Frame()
	coreAppAct(a, func() {
		if a.coreState.Layout.Tab("t1").Root.Ratio != .5 || a.coreState.Layout.Tab("t2").Root.Ratio != .5 {
			t.Fatal("old drag changed another tab's split")
		}
	})
	if len(coreRequests(f, "doc.set")) != 1 {
		t.Fatal("stale drag issued layout CAS")
	}
}
func TestGrabBesideCoreSplitDoesNotJump(t *testing.T) {
	for _, offset := range []float32{-.25, .25} {
		a, f, tt := coreGridFixture(t)
		g := find(t, tt, "core-split-grip")
		x, y := g.X+g.W/2+offset*g.W, g.Y+100
		tt.Press(x, y)
		tt.Move(x+40, y)
		tt.Move(x, y)
		tt.Release(x, y)
		awaitCoreApp(t, a, func() bool { return a.coreState.Version == 1 })
		coreAppAct(a, func() {
			if math.Abs(a.coreState.Layout.Tab("t1").Root.Ratio-.5) > .001 {
				t.Fatal("split did not return to grab ratio")
			}
		})
		if len(coreRequests(f, "doc.set")) != 1 {
			t.Fatal("drag produced multiple CAS operations")
		}
	}
}
func TestCoreOutputDuringCursorChangeKeepsPopulatedCache(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[HMmmm\x1b[H\x1b[2 q")
	before := cellPixels(tt, vtCell(t, tt, v, "a", 0, 0))
	coreOutput(t, a, f, tt, "b", "sibling output")
	if !bytes.Equal(before, cellPixels(tt, vtCell(t, tt, v, "a", 0, 0))) {
		t.Fatal("sibling output changed populated block cursor")
	}
}
