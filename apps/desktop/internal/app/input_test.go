package app

import (
	"bytes"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"unsafe"

	"vibest-desktop/internal/herdr"

	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
)

//go:linkname fileDrop github.com/egoist/mygo/ui.(*engine).fileDrop
func fileDrop(rt unsafe.Pointer, x, y float32, files []string) bool

func testerEngine(tt *ui.Tester) unsafe.Pointer {
	rt := reflect.ValueOf(tt).Elem().FieldByName("rt")
	return reflect.NewAt(rt.Type(), unsafe.Pointer(rt.UnsafeAddr())).Elem().UnsafePointer()
}

func twoPanes() shown {
	var cells []herdr.Cell
	for _, row := range []string{"abcd|01234", "efgh|56789", "ijkl|     ", "mnop|     "} {
		for _, r := range row {
			cells = append(cells, herdr.Cell{Symbol: string(r), Link: -1})
		}
	}
	s := &herdr.Surface{
		Frame: herdr.Frame{W: 10, H: 4, Cells: cells},
		Panes: []herdr.SurfacePane{
			{ID: "a", Rect: herdr.Rect{Width: 4, Height: 4}, Inner: herdr.Rect{Width: 4, Height: 4}, Focused: true},
			{ID: "b", Rect: herdr.Rect{X: 5, Width: 5, Height: 4}, Inner: herdr.Rect{X: 5, Width: 5, Height: 4}},
		},
		Splits: []herdr.SurfaceSplit{{Across: true, Pos: 5, Area: herdr.Rect{Width: 10, Height: 4}, Hit: herdr.Rect{X: 4, Width: 1, Height: 4}, Path: []bool{}}},
	}
	v := frameAt(s, 4*10+12+cardGap(0)+5*10+12, 4*20+28+4, 10, 20, 0)
	v.pane, v.tab = "a", "t"
	return v
}

func cellAt(v shown, x, y int) (float32, float32) {
	if v.s.Popup != nil {
		return v.ox + (float32(x)+0.5)*v.cw, v.oy + (float32(y)+0.5)*v.ch
	}
	for _, pl := range v.places {
		if pl.pane.Rect.Contains(x, y) {
			return pl.term.X + (float32(x-pl.pane.Inner.X)+0.5)*v.cw, pl.term.Y + (float32(y-pl.pane.Inner.Y)+0.5)*v.ch
		}
	}
	return -1, -1
}

func at(kind ui.InputKind, x, y int) ui.InputEvent {
	v := twoPanes()
	a, b, l := v.places[0].term, v.places[1].term, v.lines[0].r
	ev := ui.InputEvent{Kind: kind, X: l.X + l.W/2, Y: a.Y + (float32(y)+0.5)*v.ch}
	switch {
	case x < 4:
		ev.X = a.X + (float32(x)+0.5)*v.cw
	case x > 4:
		ev.X = b.X + (float32(x-5)+0.5)*v.cw
	}
	return ev
}

func expect(t *testing.T, name string, ok bool, fx []effect, wantOK bool, want ...effect) {
	t.Helper()
	if ok != wantOK || !reflect.DeepEqual(fx, want) && len(fx)+len(want) > 0 {
		t.Errorf("%s: got %v %#v, want %v %#v", name, ok, fx, wantOK, want)
	}
}

func TestSelectAndCopy(t *testing.T) {
	var in interaction
	v := twoPanes()
	ok, fx := in.handle(at(ui.InputPointerDown, 1, 1), v)
	expect(t, "down", ok, fx, true)
	ok, fx = in.handle(at(ui.InputPointerMove, 3, 2), v)
	expect(t, "move", ok, fx, true)
	in.handle(at(ui.InputPointerUp, 3, 2), v)
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyC, Mods: ui.Super}, v)
	expect(t, "copy", ok, fx, true, copyText("fgh\nijkl"))

	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputText, Text: "x"}, v)
	expect(t, "type", ok, fx, true, sendInput{herdr.Target{ID: "a"}, []herdr.InputEvent{herdr.Text("x")}})
	ok, _ = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyC, Mods: ui.Super}, v)
	expect(t, "copy nothing", ok, nil, false)
}

func TestSelectionGrowsWhenTheDragScrolls(t *testing.T) {
	var in interaction
	v := twoPanes()
	v.s.Panes[0].Scroll = &herdr.Scroll{Offset: 2, Max: 10, Rows: 4}
	ok, fx := in.handle(at(ui.InputPointerDown, 1, 1), v)
	expect(t, "down", ok, fx, true)
	ev := ui.InputEvent{Kind: ui.InputPointerMove, X: 15, Y: -30}
	ok, fx = in.handle(ev, v)
	expect(t, "past the top", ok, fx, true)
	fx = in.selectionScroll(v)
	expect(t, "frame", true, fx, true, paneScroll{id: "a", offset: 3})
	if in.sel.ayFrom != 4 || in.sel.hyFrom != 6 {
		t.Fatalf("rows from the bottom anchor %d head %d, want 4 and 6", in.sel.ayFrom, in.sel.hyFrom)
	}
	fx = in.selectionScroll(v)
	expect(t, "waiting", true, fx, true)
	v.s.Panes[0].Scroll.Offset = 3
	sc, placed := in.sel.project(&v.s.Panes[0])
	if !placed || sc.ay != 2 || sc.hy != 0 {
		t.Fatalf("on screen anchor %d head %d placed %v, want 2 and 0", sc.ay, sc.hy, placed)
	}
	fx = in.selectionScroll(v)
	expect(t, "tick", true, fx, true, paneScroll{id: "a", offset: 4})
	if in.sel.hyFrom != 7 {
		t.Fatalf("head after the tick %d, want 7", in.sel.hyFrom)
	}

	v.s.Panes[0].Scroll.Offset = 4
	ev.Y = 20*4 + 30
	ok, fx = in.handle(ev, v)
	expect(t, "past the bottom", ok, fx, true)
	fx = in.selectionScroll(v)
	expect(t, "toward the live end", true, fx, true, paneScroll{id: "a", offset: 3})
	if in.sel.ayFrom != 4 {
		t.Fatalf("anchor moved to %d", in.sel.ayFrom)
	}
	v.s.Panes[0].Scroll.Offset = 3
	sc, placed = in.sel.project(&v.s.Panes[0])
	if !placed || sc.hy != 3 {
		t.Fatalf("head on screen %d placed %v, want the bottom row 3", sc.hy, placed)
	}
}

func TestSelectionDoesNotScrollAnEmptyPane(t *testing.T) {
	var in interaction
	v := twoPanes()
	v.s.Panes[0].Inner.Height = 0
	v.s.Panes[0].Scroll = &herdr.Scroll{Offset: 2, Max: 10}
	ok, fx := in.handle(at(ui.InputPointerDown, 1, 1), v)
	expect(t, "down", ok, fx, false)
	if in.sel != nil {
		t.Fatal("an empty pane started a selection")
	}
	in.sel = &selection{pane: "a", ayFrom: 1, hyFrom: 1, delta: 1, sent: -1}
	fx = in.selectionScroll(v)
	expect(t, "scroll", true, fx, true)
	if in.sel.delta != 0 {
		t.Fatalf("delta %d, want the drag to stop", in.sel.delta)
	}
}

func TestDoubleClickSelectsWord(t *testing.T) {
	var in interaction
	v := twoPanes()
	ev := at(ui.InputPointerDown, 7, 0)
	ev.Clicks = 2
	ok, fx := in.handle(ev, v)
	expect(t, "down", ok, fx, true, focusPane("b"))
	_, fx = in.copy(v)
	expect(t, "copy", true, fx, true, copyText("01234"))
}

func TestDragBorder(t *testing.T) {
	var in interaction
	v := twoPanes()
	ok, fx := in.handle(at(ui.InputPointerDown, 4, 1), v)
	expect(t, "down", ok, fx, true)
	x := at(ui.InputPointerDown, 4, 1).X
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputPointerMove, X: x + 20, Y: 30}, v)
	expect(t, "move", ok, fx, true, ratio{"t", []bool{}, 0.7})
	_, fx = in.handle(ui.InputEvent{Kind: ui.InputPointerMove, X: 99, Y: 30}, v)
	expect(t, "clamped", true, fx, true, ratio{"t", []bool{}, 0.9})
	in.handle(at(ui.InputPointerUp, 9, 1), v)
	ok, fx = in.handle(at(ui.InputPointerMove, 6, 1), v)
	expect(t, "after", ok, fx, false)
}

func TestMouseReporting(t *testing.T) {
	var in interaction
	v := twoPanes()
	v.s.Panes[1].MouseReporting = true
	b := herdr.Target{ID: "b"}
	ok, fx := in.handle(at(ui.InputPointerDown, 6, 1), v)
	expect(t, "down", ok, fx, true, focusPane("b"), sendInput{b, []herdr.InputEvent{herdr.Mouse{Kind: herdr.MouseDown, Col: 1, Row: 1}}})
	ok, fx = in.handle(at(ui.InputPointerMove, 6, 1), v)
	expect(t, "same cell", ok, fx, true)
	_, fx = in.handle(at(ui.InputPointerMove, 20, 2), v)
	expect(t, "drag", true, fx, true, sendInput{b, []herdr.InputEvent{herdr.Mouse{Kind: herdr.MouseDrag, Col: 4, Row: 2}}})
	_, fx = in.handle(at(ui.InputPointerUp, 20, 2), v)
	expect(t, "up", true, fx, true, sendInput{b, []herdr.InputEvent{herdr.Mouse{Kind: herdr.MouseUp, Col: 4, Row: 2}}})
}

func TestRightClickOpensThePaneMenu(t *testing.T) {
	var in interaction
	v := twoPanes()
	v.s.Panes[0].MouseReporting = true
	ev := at(ui.InputPointerDown, 1, 1)
	ev.Button = 1
	ok, fx := in.handle(ev, v)
	expect(t, "menu", ok, fx, false, openPaneMenu{"a", ev.X, ev.Y})
	v.rightToPane = map[string]bool{"a": true}
	ok, fx = in.handle(ev, v)
	b := herdr.Target{ID: "a"}
	expect(t, "routed", ok, fx, true, sendInput{b, []herdr.InputEvent{herdr.Mouse{Kind: herdr.MouseDown, Button: 1, Col: 1, Row: 1}}})
}

func TestScroll(t *testing.T) {
	var in interaction
	v := twoPanes()

	ev := at(ui.InputScroll, 1, 1)
	ev.DY = -wheelNotch
	ok, fx := in.handle(ev, v)
	expect(t, "notch up", ok, fx, true, scrollReport("a", herdr.MouseScrollUp, 1, 1, wheelRows, 0))
	ok, fx = in.handle(ev, v)
	expect(t, "held", ok, fx, true, scrollReport("a", herdr.MouseScrollUp, 1, 1, wheelRows, 0))

	ev.DY = -50
	ok, fx = in.handle(ev, v)
	expect(t, "linux notch", ok, fx, true, scrollReport("a", herdr.MouseScrollUp, 1, 1, wheelRows, 0))
	ok, fx = in.handle(ev, v)
	expect(t, "linux next", ok, fx, true, scrollReport("a", herdr.MouseScrollUp, 1, 1, wheelRows, 0))

	var pad interaction
	ev = at(ui.InputScroll, 1, 1)
	ev.Precise = true
	ev.DY = 10
	ok, fx = pad.handle(ev, v)
	expect(t, "half a cell", ok, fx, true)
	ev.DY = 10
	ok, fx = pad.handle(ev, v)
	expect(t, "one cell", ok, fx, true, scrollReport("a", herdr.MouseScrollDown, 1, 1, 1, 0))
	ev.DY = v.ch
	ok, fx = pad.handle(ev, v)
	expect(t, "precise row", ok, fx, true, scrollReport("a", herdr.MouseScrollDown, 1, 1, 1, 0))

	ev.DY = 2*v.ch + 10
	ok, fx = pad.handle(ev, v)
	expect(t, "two cells", ok, fx, true, scrollReport("a", herdr.MouseScrollDown, 1, 1, 2, 0))
	ev.DY = 10
	ok, fx = pad.handle(ev, v)
	expect(t, "remainder", ok, fx, true, scrollReport("a", herdr.MouseScrollDown, 1, 1, 1, 0))
}

func TestNotchIsOneWheelReport(t *testing.T) {
	var in interaction
	v := twoPanes()
	v.s.Panes[0].MouseReporting = true
	ev := at(ui.InputScroll, 1, 1)
	ev.DY = wheelNotch
	ok, fx := in.handle(ev, v)
	expect(t, "notch", ok, fx, true, scrollReport("a", herdr.MouseScrollDown, 1, 1, wheelRows, 0))
	ok, fx = in.handle(ev, v)
	expect(t, "next notch", ok, fx, true, scrollReport("a", herdr.MouseScrollDown, 1, 1, wheelRows, 0))
	ev.DY = -50
	ok, fx = in.handle(ev, v)
	expect(t, "linux notch", ok, fx, true, scrollReport("a", herdr.MouseScrollUp, 1, 1, wheelRows, 0))
	ok, fx = in.handle(ev, v)
	expect(t, "linux next", ok, fx, true, scrollReport("a", herdr.MouseScrollUp, 1, 1, wheelRows, 0))

	ev.DY = -wheelNotch
	ev.Mods = ui.Shift
	ok, fx = in.handle(ev, v)
	expect(t, "shift", ok, fx, true, scrollReport("a", herdr.MouseScrollUp, 1, 1, wheelRows, herdr.ModShift))

	var bare interaction
	v.s.Panes[0].MouseReporting = false
	v.s.Panes[0].Scroll = nil
	ev = at(ui.InputScroll, 1, 1)
	ev.DY = -wheelNotch
	ok, fx = bare.handle(ev, v)
	expect(t, "no scroll info", ok, fx, true, scrollReport("a", herdr.MouseScrollUp, 1, 1, wheelRows, 0))
}

func scrollReport(id string, kind, col, row, lines int, mods uint8) sendInput {
	return sendInput{herdr.Target{ID: id}, []herdr.InputEvent{
		herdr.Mouse{Kind: kind, Col: col, Row: row, Mods: mods, Lines: lines},
	}}
}

func TestPopupTakesInput(t *testing.T) {
	var in interaction
	v := twoPanes()
	v.s.Popup = &herdr.Popup{TerminalID: "p", Frame: herdr.Frame{W: 4, H: 2}}
	p := herdr.Target{ID: "p", Popup: true}
	ok, fx := in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyA, Mods: ui.Ctrl}, v)
	expect(t, "key", ok, fx, true, sendInput{p, []herdr.InputEvent{herdr.Key{Code: herdr.KeyChar, Char: 'a', Mods: herdr.ModCtrl}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyLeft, Mods: ui.Super}, v)
	expect(t, "cmd-left", ok, fx, true, sendInput{p, []herdr.InputEvent{herdr.Key{Code: herdr.KeyChar, Char: 'a', Mods: herdr.ModCtrl}}})
	ok, fx = in.handle(at(ui.InputPointerDown, 0, 0), v)
	expect(t, "outside", ok, fx, true)
	ok, fx = in.handle(at(ui.InputPointerDown, 4, 1), v)
	expect(t, "inside", ok, fx, true)
	if in.drag != nil || in.sel != nil {
		t.Errorf("popup click dragged %v or selected %v", in.drag, in.sel)
	}
}

func TestKeys(t *testing.T) {
	var in interaction
	v := twoPanes()
	a := herdr.Target{ID: "a"}
	ok, fx := in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyTab, Mods: ui.Shift}, v)
	expect(t, "shift-tab", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyBackTab, Mods: herdr.ModShift}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyA}, v)
	expect(t, "a types text", ok, fx, true)
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyT, Mods: ui.Super}, v)
	expect(t, "cmd-t", ok, fx, false)
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyV, Mods: ui.Super}, v)
	expect(t, "paste", ok, fx, true, pasteTo{to: a})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyBackspace}, v)
	expect(t, "backspace", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyBackspace}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyLeft}, v)
	expect(t, "left", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyLeft}}})
	in.handle(at(ui.InputPointerDown, 1, 1), v)
	in.handle(at(ui.InputPointerMove, 2, 1), v)
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyBackspace, Mods: ui.Super, Repeat: true}, v)
	expect(t, "cmd-delete", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyChar, Char: 'u', Mods: herdr.ModCtrl, Repeat: true}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyC, Mods: ui.Super}, v)
	expect(t, "cmd-delete clears selection", ok, fx, false)
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyLeft, Mods: ui.Super}, v)
	expect(t, "cmd-left", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyChar, Char: 'a', Mods: herdr.ModCtrl}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyRight, Mods: ui.Super}, v)
	expect(t, "cmd-right", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyChar, Char: 'e', Mods: herdr.ModCtrl}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyLeft, Mods: ui.Alt}, v)
	expect(t, "opt-left", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyChar, Char: 'b', Mods: herdr.ModAlt}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyRight, Mods: ui.Alt, Repeat: true}, v)
	expect(t, "opt-right", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyChar, Char: 'f', Mods: herdr.ModAlt, Repeat: true}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyEnter, Mods: ui.Shift}, v)
	expect(t, "shift-enter", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyEnter, Mods: herdr.ModAlt}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyUp, Mods: ui.Alt}, v)
	expect(t, "opt-up", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyUp, Mods: herdr.ModAlt}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyLeft, Mods: ui.Alt | ui.Shift}, v)
	expect(t, "opt-shift-left", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyLeft, Mods: herdr.ModAlt | herdr.ModShift}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyBackspace, Mods: ui.Super | ui.Shift}, v)
	expect(t, "cmd-shift-backspace", ok, fx, false)
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyLeft, Mods: ui.Super | ui.Shift}, v)
	expect(t, "cmd-shift-left", ok, fx, false)
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyDelete, Mods: ui.Super}, v)
	expect(t, "cmd-forward-delete", ok, fx, false)
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyEnter, Mods: ui.Super | ui.Shift}, v)
	expect(t, "cmd-shift-enter", ok, fx, false)
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyW, Mods: ui.Ctrl}, v)
	expect(t, "ctrl-w", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Key{Code: herdr.KeyChar, Char: 'w', Mods: herdr.ModCtrl}}})
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyW, Mods: ui.Super}, v)
	expect(t, "command-w left to the shortcut", ok, fx, false)
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyW, Mods: ui.Super | ui.Shift}, v)
	expect(t, "command-shift-w left to the shortcut", ok, fx, false)
	if ui.Cmd != ui.Ctrl {
		ok, fx = in.handle(ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyW, Mods: ui.Cmd}, v)
		expect(t, "cmd-w left to the shortcut", ok, fx, false)
	}
}

func TestClipboardPaths(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		if p, err := clipboardPaths(transfer.Data{}); len(p) != 0 || err != nil {
			t.Fatalf("got %q, %v", p, err)
		}
	})
	t.Run("files", func(t *testing.T) {
		d := transfer.New(
			transfer.NewItem(transfer.Bytes(transfer.URIList, []byte("file:///tmp/a%20b.txt\r\n"))),
			transfer.NewItem(transfer.Bytes(transfer.URIList, []byte("file:///tmp/c.txt\r\n"))),
		)
		p, err := clipboardPaths(d)
		if err != nil || !reflect.DeepEqual(p, []string{"/tmp/a b.txt", "/tmp/c.txt"}) {
			t.Fatalf("got %q, %v", p, err)
		}
		if got, err := quotePaths(p, quoteBackslash); err != nil || got != `/tmp/a\ b.txt /tmp/c.txt` {
			t.Fatalf("got %q %v", got, err)
		}
	})
	t.Run("image", func(t *testing.T) {
		dir := t.TempDir() + "/with space"
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("TMPDIR", dir)
		png := append([]byte("\x89PNG\r\n\x1a\n"), "rest"...)
		p, err := clipboardPaths(transfer.New(transfer.NewItem(transfer.Bytes(transfer.PNG, png))))
		if err != nil || len(p) != 1 {
			t.Fatalf("got %q, %v", p, err)
		}
		if b, _ := os.ReadFile(p[0]); !bytes.Equal(b, png) {
			t.Fatalf("file %s holds %q", p[0], b)
		}
		got, err := quotePaths(p, quoteBackslash)
		if err != nil || !strings.Contains(got, `with\ space`) {
			t.Fatalf("image path not escaped: %q %v", got, err)
		}
	})
}

func TestQuotePaths(t *testing.T) {
	got, err := quotePaths([]string{"/tmp/my file"}, quotePOSIX)
	if err != nil || got != "'/tmp/my file'" {
		t.Fatalf("space: %q %v", got, err)
	}
	if back, err := quotePaths([]string{"/tmp/my file"}, quoteBackslash); err != nil || back != `/tmp/my\ file` {
		t.Fatalf("backslash: %q %v", back, err)
	}
	got, err = quotePaths([]string{"it's"}, quotePOSIX)
	if err != nil || got != `'it'\''s'` {
		t.Fatalf("quote: %q %v", got, err)
	}
	got, err = quotePaths([]string{"/tmp/中文.txt"}, quotePOSIX)
	if err != nil || got != "'/tmp/中文.txt'" {
		t.Fatalf("text: %q %v", got, err)
	}
	got, err = quotePaths([]string{"/a", "/b"}, quotePOSIX)
	if err != nil || got != "'/a' '/b'" || strings.Contains(got, "\n") {
		t.Fatalf("two paths: %q %v", got, err)
	}
	if got, err := quotePaths(nil, quotePOSIX); err != nil || got != "" {
		t.Fatalf("empty: %q %v", got, err)
	}
	if _, err := quotePaths([]string{"a\nb"}, quotePOSIX); !errors.Is(err, errPasteControl) {
		t.Fatalf("newline: %v", err)
	}
	if _, err := quotePaths([]string{"ok", "\x7f"}, quoteBackslash); !errors.Is(err, errPasteControl) {
		t.Fatalf("del: %v", err)
	}
	if _, err := quotePaths([]string{"fine", string([]byte{0xff})}, quotePOSIX); !errors.Is(err, errPastePath) {
		t.Fatalf("bytes: %v", err)
	}
	many := make([]string, maxPastePaths+1)
	for i := range many {
		many[i] = "a"
	}
	if _, err := quotePaths(many, quotePOSIX); !errors.Is(err, errPasteTooMany) {
		t.Fatalf("count: %v", err)
	}
	long := strings.Repeat("a", maxPasteBytes)
	if _, err := quotePaths([]string{long}, quotePOSIX); !errors.Is(err, errPasteTooLong) {
		t.Fatalf("long: %v", err)
	}
	fit := strings.Repeat("b", maxPasteBytes-2)
	got, err = quotePaths([]string{fit}, quotePOSIX)
	if err != nil || len(got) != maxPasteBytes || strings.Contains(got, "\n") {
		t.Fatalf("fit: len %d %v", len(got), err)
	}
}

func TestRegions(t *testing.T) {
	v := twoPanes()
	for _, c := range []struct {
		x, y int
		want herdr.Target
	}{{1, 1, herdr.Target{ID: "a"}}, {6, 1, herdr.Target{ID: "b"}}} {
		ev := at(ui.InputPointerDown, c.x, c.y)
		if got, x, y, ok := v.region(ev.X, ev.Y); !ok || got.target != c.want || x != c.x || y != c.y {
			t.Fatalf("cell %d,%d: %+v %d,%d %v", c.x, c.y, got.target, x, y, ok)
		}
	}
	if l := v.lines[0].r; true {
		if _, _, _, ok := v.region(l.X+l.W/2, l.Y+50); ok {
			t.Fatal("the line is a terminal")
		}
	}
	v.s.Panes[0].ID = ""
	if _, _, _, ok := v.region(at(ui.InputPointerDown, 1, 1).X, at(ui.InputPointerDown, 1, 1).Y); ok {
		t.Fatal("empty id is still a target")
	}
	v.s.Popup = &herdr.Popup{TerminalID: "p", Frame: herdr.Frame{W: 4, H: 2}}
	v = frameAt(v.s, v.w, v.h, v.cw, v.ch, v.scale)
	pr := popupRect(v.s)
	px, py := v.ox+(float32(pr.X)+0.5)*v.cw, v.oy+(float32(pr.Y)+0.5)*v.ch
	if got, x, y, ok := v.region(px, py); !ok || got.target != (herdr.Target{ID: "p", Popup: true}) || x != pr.X || y != pr.Y {
		t.Fatalf("popup cell: %+v %d,%d %v", got.target, x, y, ok)
	}
	if _, _, _, ok := v.region(px-v.cw, py); ok {
		t.Fatal("popup open still hits a pane")
	}
	v.s.Popup.TerminalID = ""
	if _, _, _, ok := v.region(px, py); ok {
		t.Fatal("empty popup id is a target")
	}
}

func TestDroppedFilePaste(t *testing.T) {
	a, f, tt := coreShellFixture(t, 800, 500, 1, false, "single")
	v := coreOutput(t, a, f, tt, "a", "\x1b[?2004h")
	r := vtCell(t, tt, v, "a", 1, 1)
	drop := func(paths []string) bool {
		return fileDrop(testerEngine(tt), float32(r.Min.X+r.Max.X)/2, float32(r.Min.Y+r.Max.Y)/2, paths)
	}
	if !drop([]string{"/tmp/my file", "it's"}) {
		t.Fatal("terminal did not take file drop")
	}
	tt.Frame()
	wantCorePaneInput(t, f, "a", "\x1b[200~"+`'/tmp/my file' 'it'\''s'`+"\x1b[201~")
	tt.Frame()
	noCoreData(t, f)
	coreAppAct(a, func() { a.askInWindow("Popup", "", false, func(string) {}) })
	tt.Frame()
	drop([]string{"/tmp/refused"})
	tt.Frame()
	noCoreData(t, f)
	tt.Key(0, ui.KeyEscape)
	readyCorePane(t, a, tt, "a")
	if !drop([]string{"/tmp/valid", "bad\npath"}) {
		t.Fatal("invalid drop not consumed")
	}
	tt.Frame()
	awaitCoreApp(t, a, func() bool { return strings.Contains(a.navigationNote, "control character") })
	tt.Frame()
	noCoreData(t, f)
	if !tt.HasText("A file path contains a control character") {
		t.Fatal("path refusal not visible", tt.Texts())
	}
	if !drop([]string{"/tmp/later"}) {
		t.Fatal("valid drop after refusal failed")
	}
	tt.Frame()
	wantCorePaneInput(t, f, "a", "\x1b[200~'/tmp/later'\x1b[201~")
	noCoreData(t, f)
}

func TestFileDropZonesBuild(t *testing.T) {
	a, f, tt := coreShellFixture(t, 800, 500, 1, false, "single")
	v := coreOutput(t, a, f, tt, "a", "\x1b[Hselect these words")
	start, end := vtCell(t, tt, v, "a", 0, 0), vtCell(t, tt, v, "a", 5, 0)
	tt.Press(float32(start.Min.X+1), float32(start.Min.Y+start.Dy()/2))
	tt.Move(float32(end.Max.X-1), float32(end.Min.Y+end.Dy()/2))
	tt.Release(float32(end.Max.X-1), float32(end.Min.Y+end.Dy()/2))
	tt.Command("copy")
	if !strings.HasPrefix(tt.Clipboard(), "select") {
		t.Fatal("file-drop zone took terminal selection", tt.Clipboard())
	}
	head := find(t, tt, "pane-header/a")
	if fileDrop(testerEngine(tt), head.X+10, head.Y+10, []string{"/tmp/no"}) {
		t.Fatal("header registered as terminal drop zone")
	}
	noCoreData(t, f)
}

func TestShellEscape(t *testing.T) {
	if got, want := shellEscape("/a b/(c)'d.png"), `/a\ b/\(c\)\'d.png`; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestFramedPaneRowsFollowTheShift(t *testing.T) {
	cells := make([]herdr.Cell, 6*6)
	for i := range cells {
		cells[i] = herdr.Cell{Symbol: string(rune('a' + i%26)), Link: -1}
	}
	s := &herdr.Surface{
		Frame: herdr.Frame{W: 6, H: 6, Cells: cells},
		Panes: []herdr.SurfacePane{{ID: "a", Rect: herdr.Rect{Width: 6, Height: 6}, Inner: herdr.Rect{X: 1, Y: 1, Width: 4, Height: 4}, Focused: true, MouseReporting: true}},
	}
	v := frameAt(s, 60, 120, 10, 20, 1)
	v.pane, v.tab = "a", "t"
	a := herdr.Target{ID: "a"}
	down := func(y float32) ui.InputEvent { return ui.InputEvent{Kind: ui.InputPointerDown, X: 9, Y: y} }
	var in interaction
	ok, fx := in.handle(down(40), v)
	expect(t, "top row", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Mouse{Kind: herdr.MouseDown, Col: 0, Row: 0}}})
	in.handle(ui.InputEvent{Kind: ui.InputPointerUp, X: 9, Y: 40}, v)
	ok, fx = in.handle(down(56), v)
	expect(t, "second row", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Mouse{Kind: herdr.MouseDown, Col: 0, Row: 1}}})
	_, fx = in.handle(ui.InputEvent{Kind: ui.InputPointerMove, X: 9, Y: 76}, v)
	expect(t, "drag", true, fx, true, sendInput{a, []herdr.InputEvent{herdr.Mouse{Kind: herdr.MouseDrag, Col: 0, Row: 2}}})
	in.handle(ui.InputEvent{Kind: ui.InputPointerUp, X: 9, Y: 76}, v)

	in = interaction{}
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputScroll, X: 9, Y: 40, DY: -wheelNotch}, v)
	expect(t, "wheel", ok, fx, true, scrollReport("a", herdr.MouseScrollUp, 0, 0, wheelRows, 0))

	in = interaction{}
	ok, fx = in.handle(ui.InputEvent{Kind: ui.InputPointerDown, X: 19, Y: 40}, v)
	expect(t, "second column", ok, fx, true, sendInput{a, []herdr.InputEvent{herdr.Mouse{Kind: herdr.MouseDown, Col: 1, Row: 0}}})

	s.Panes[0].MouseReporting = false
	in = interaction{}
	in.handle(down(40), v)
	in.handle(ui.InputEvent{Kind: ui.InputPointerMove, X: 19, Y: 56, Button: 0}, v)
	in.handle(ui.InputEvent{Kind: ui.InputPointerUp, X: 19, Y: 56}, v)
	_, fx = in.copy(v)
	want := string([]rune{rune('a' + 7), rune('a' + 8), rune('a' + 9), rune('a' + 10), '\n', rune('a' + 13), rune('a' + 14)})
	expect(t, "copy", true, fx, true, copyText(want))
}

func TestFramedSplitTakesItsLine(t *testing.T) {
	s, _ := herdrSurface(stack(0.5, leaf("a"), leaf("b")), 6, 13, hconf{borders: "auto", outer: true, scrollbars: true})
	v := frameAt(s, 200, 400, 10, 20, 1)
	v.pane, v.tab = "a", "t"
	l, a, b := v.lines[0].r, v.places[0], v.places[1]
	for _, y := range []float32{l.Y + l.H/2, l.Y - 1} {
		var in interaction
		ok, fx := in.handle(ui.InputEvent{Kind: ui.InputPointerDown, X: 15, Y: y}, v)
		expect(t, "down", ok, fx, true)
		ok, fx = in.handle(ui.InputEvent{Kind: ui.InputPointerMove, X: 15, Y: y + 25}, v)
		expect(t, "drag", ok, fx, true, ratio{"t", []bool{}, float32(s.Splits[0].Pos+1) / 13})
	}
	for _, y := range []float32{a.term.Y + a.term.H - 1, b.head.Y + 3} {
		var in interaction
		in.handle(ui.InputEvent{Kind: ui.InputPointerDown, X: 15, Y: y}, v)
		if in.drag != nil {
			t.Fatalf("press at y %v grabbed the divider", y)
		}
	}
}
