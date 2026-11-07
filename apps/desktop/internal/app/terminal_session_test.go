package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
	"vibest-desktop/internal/core"
)

func TestTerminalCompositionTracksLogicalOwnerNotGeometry(t *testing.T) {
	for _, kind := range []string{"program", "pane", "session", "modal", "cursor", "geometry", "background"} {
		t.Run(kind, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			coreAppAct(a, func() { a.ShowPane("b") })
			old := readyCorePane(t, a, tt, "b")
			tt.Compose("字", 1)
			if vtView(t, old).FieldByName("preedit").String() != "字" {
				t.Fatal("preedit missing")
			}
			id := "b"
			changed := true
			switch kind {
			case "program":
				f.mu.Lock()
				r := f.terminals[id]
				f.mu.Unlock()
				f.report("restarted", r)
				awaitCoreApp(t, a, func() bool { return a.coreState.Programs[id] == 1 })
			case "pane":
				id = "a"
				coreAppAct(a, func() { a.ShowPane(id) })
			case "session":
				f = reconnectCoreApp(t, a, f, coreActivitySeed)
			case "modal":
				coreAppAct(a, func() { a.askInWindow("Modal", "", false, func(string) {}) })
				tt.Frame()
			case "cursor":
				changed = false
				coreOutput(t, a, f, tt, "b", "\x1b[2;3H")
			case "geometry":
				changed = false
				coreAppAct(a, func() { a.coreEdit(func(l *core.Layout) error { return l.SetRatio("t1", nil, .65) }) })
				awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Tab("t1").Root.Ratio == .65 })
			case "background":
				changed = false
				f.mu.Lock()
				r := f.terminals["c"]
				f.mu.Unlock()
				f.report("restarted", r)
				awaitCoreApp(t, a, func() bool { return a.coreState.Programs["c"] == 1 })
			}
			tt.Frame()
			pre := vtView(t, old).FieldByName("preedit").String()
			if changed && pre != "" || !changed && pre != "字" {
				t.Fatal("composition lifetime disagrees with logical ownership", kind, pre)
			}
			noCoreData(t, f)
			if kind == "modal" {
				tt.Key(0, ui.KeyEscape)
			}
			readyCorePane(t, a, tt, id)
			tt.Compose("新", 1)
			if vtView(t, a.coreViews[id]).FieldByName("preedit").String() != "新" {
				t.Fatal("fresh composition rejected")
			}
			tt.TypeKeyNative(0, ui.KeyX, "x")
			wantCorePaneInput(t, f, id, "x")
			noCoreData(t, f)
		})
	}
}

func TestTerminalMissingBootCannotEnableNativeInput(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	old := a.coreViews["a"]
	tt.Compose("字", 1)
	f.peer.Close()
	awaitCoreApp(t, a, func() bool { return !a.coreState.Connected })
	tt.Frame()
	if vtView(t, old).FieldByName("preedit").String() != "" {
		t.Fatal("untrusted owner retained composition")
	}
	if active, _ := tt.TextInputActive(); active {
		t.Fatal("disconnected viewer enabled native text")
	}
	tt.TypeKeyNative(0, ui.KeyX, "x")
	noCoreData(t, f)
}
