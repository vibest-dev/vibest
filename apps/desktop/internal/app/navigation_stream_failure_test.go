package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
)

func TestNavigationFailedCommittedPrefixStopsOnlyItsConnection(t *testing.T) {
	for _, kind := range []string{"ready-text", "navigation-batch"} {
		t.Run(kind, func(t *testing.T) {
			a, f, tt, b, release := blockedCoreUI(t, "x", true)
			_, healthy, other := coreActivityUI(t)
			if kind == "ready-text" {
				if !tt.CommitTextNative("x") {
					t.Fatal("native commit inactive")
				}
			} else {
				coreAppAct(a, func() { a.SelectTab("t2") })
				tt.Frame()
				tt.Type("x")
				readyCorePane(t, a, tt, "c")
			}
			waitCoreWrite(t, b)
			tt.KeyUnframed(0, ui.KeyEnter)
			other.TypeKeyNative(0, ui.KeyY, "y")
			wantCorePaneInput(t, healthy, "a", "y")
			release()
			awaitCoreApp(t, a, func() bool { return !a.coreState.Connected })
			tt.Frame()
			noCoreData(t, f)
			if b.attempts.Load() != 1 {
				t.Fatal("failed DATA allowed trailing writes", b.attempts.Load())
			}
			other.Type("z")
			wantCorePaneInput(t, healthy, "a", "z")
			noCoreData(t, f)
		})
	}
}
