package app

import (
	"errors"
	"testing"
	"vibest-desktop/internal/core"
)

func TestTerminalNativePreflightReconcilesOwnerWithoutCallerFrame(t *testing.T) {
	for _, kind := range []string{"program-before-paint", "pane", "same-owner"} {
		t.Run(kind, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			awaitCorePaintWithoutOwnership(t, a, tt, "b")
			old := a.coreViews["a"]
			tt.Compose("字", 1)
			if vtView(t, old).FieldByName("preedit").String() != "字" {
				t.Fatal("missing actual preedit")
			}
			id := "a"
			switch kind {
			case "pane":
				id = "b"
				coreAppAct(a, func() { a.ShowPane(id) })
			case "program-before-paint":
				f.mu.Lock()
				r := f.terminals["a"]
				f.mu.Unlock()
				f.report("restarted", r)
				awaitCoreApp(t, a, func() bool { return a.coreState.Programs["a"] == 1 })
				if tt.CommitTextNative("unpainted") {
					t.Fatal("replacement without parsed paint claimed native eligibility")
				}
				noCoreData(t, f)
				readyCorePane(t, a, tt, "a")
			}
			if !tt.CommitTextNative("x") {
				t.Fatal("fresh prepared commit ineligible")
			}
			wantCorePaneInput(t, f, id, "x")
			tt.Frame()
			if vtView(t, a.coreViews[id]).FieldByName("preedit").String() != "" || !tt.Focused("terminal/"+id) {
				t.Fatal("preflight retained preedit or lost focus")
			}
			noCoreData(t, f)
		})
	}
}
func TestTerminalPreparedHandlerRejectsModelChangeBeforeAcceptance(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	old := a.coreViews["a"]
	tt.Compose("字", 1)
	captured, ok := a.coreKeyboard.CaptureFor(old.Viewer)
	if !ok {
		t.Fatal("missing prepared owner")
	}
	coreAppAct(a, func() { a.ShowPane("b") })
	for _, data := range []string{"字", "\r", "paste"} {
		if n, err := captured.Write([]byte(data)); n != 0 || !errors.Is(err, core.ErrOwnership) {
			t.Fatal("stale prepared owner admitted input", n, err)
		}
	}
	noCoreData(t, f)
	if vtView(t, old).FieldByName("preedit").String() != "" {
		t.Fatal("old composition retained")
	}
	if !tt.CommitTextNative("x") {
		t.Fatal("fresh native commit rejected")
	}
	wantCorePaneInput(t, f, "b", "x")
	noCoreData(t, f)
}
