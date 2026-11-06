package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
)

func TestNavigationCanceledModalDoesNotResumeUnacknowledgedInput(t *testing.T) {
	a, f, tt, n, release := pendingCoreNavigation(t)
	tt.TypeKeyNative(0, ui.KeyX, "held")
	coreAppAct(a, func() { a.askInWindow("Cancel navigation", "", false, func(string) {}) })
	tt.Frame()
	if err := tt.Click("Cancel"); err != nil {
		t.Fatal(err)
	}
	tt.TypeKeyNative(0, ui.KeyY, "y")
	tt.Key(0, ui.KeyEnter)
	noCoreData(t, f)
	release()
	awaitCorePaintWithoutOwnership(t, a, tt, "c")
	tt.TypeKeyNative(0, ui.KeyZ, "z")
	noCoreData(t, f)
	coreAppAct(a, func() {
		if n.events != nil || a.coreCapture != nil || !a.coreBlocked {
			t.Fatal("canceled intent was resumed by late readiness")
		}
	})
	navigationRelease(t, tt, "tab/t2")
	if !tt.TypeKeyNative(0, ui.KeyQ, "q") {
		t.Fatal("fresh activation lost its first native character")
	}
	readyCorePane(t, a, tt, "c")
	wantCoreInput(t, f, "q")
}
func TestGenericTypeKeyDoesNotProvePendingLayoutEligibility(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	tt.SetSize(80, 60)
	tt.Frame()
	tt.Frame()
	if tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("clipped terminal claimed native eligibility")
	}
	noCoreData(t, f)
	tt.TypeKey(0, ui.KeyX, "x")
	noCoreData(t, f)
	coreAppAct(a, func() {
		if a.coreViews["a"].InputReady() {
			t.Fatal("synthetic key established paint readiness")
		}
	})
}
func TestNavigationTargetSensitiveShortcutCannotOvertakeHeldText(t *testing.T) {
	for _, key := range []struct {
		mods ui.Modifiers
		key  ui.Key
	}{{ui.Cmd, ui.KeyK}, {ui.Cmd | ui.Shift, ui.KeyW}} {
		a, f, tt, n, release := pendingCoreNavigation(t)
		tt.TypeKeyNative(0, ui.KeyX, "held")
		tt.Key(key.mods, key.key)
		coreAppAct(a, func() {
			if a.coreCapture != nil || n.events != nil || !a.coreBlocked {
				t.Fatal("target-bound command failed open")
			}
		})
		if len(coreRequests(f, "terminal.kill"))+len(coreRequests(f, "doc.set")) != 0 {
			t.Fatal("command mutated old target")
		}
		release()
		awaitCorePaintWithoutOwnership(t, a, tt, "c")
		noCoreData(t, f)
	}
}
