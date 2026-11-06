package app

import (
	"fmt"
	"github.com/egoist/mygo/ui"
	"testing"
)

func TestNavigationNativeClosedWindowRejectsLateCompletion(t *testing.T) {
	a, _ := newCoreAppFixtureWith(t, coreActivitySeed)
	run, cancel := 0, 0
	d := &dialog{run: func(string) { run++ }, cancel: func() { cancel++ }}
	coreAppAct(a, func() { a.beginNativeDialog(d) })
	a.Focus(false)
	a.WindowClosed()
	a.WindowClosed()
	focus := false
	coreAppAct(a, func() {
		a.finishNativeDialog(d, true, "late")
		a.finishNativeDialog(d, false, "")
		focus = a.returnFocus
		replacement := &dialog{run: func(string) { run++ }, cancel: func() { cancel++ }}
		a.beginNativeDialog(replacement)
		a.finishNativeDialog(replacement, true, "late replacement")
	})
	if run != 0 || cancel != 2 || focus {
		t.Fatal("closed owner ran or resumed", run, cancel, focus)
	}
}
func TestNavigationNativeOwnedFocusChurnKeepsCompletion(t *testing.T) {
	for _, ready := range []bool{false, true} {
		for _, accept := range []bool{false, true} {
			t.Run(fmt.Sprint(ready, accept), func(t *testing.T) {
				a, f, tt, _, release := pendingCoreNavigation(t)
				tt.Type("h")
				tt.KeyUnframed(0, ui.KeyEnter)
				run, cancel := 0, 0
				d := &dialog{run: func(string) { run++ }, cancel: func() { cancel++ }}
				var generation uint64
				coreAppAct(a, func() { a.beginNativeDialog(d); generation = a.navigationGeneration })
				a.Focus(false)
				a.Focus(true)
				tt.Frame()
				coreAppAct(a, func() {
					if a.nativeDialog != d || a.navigationGeneration != generation {
						t.Fatal("owning focus churn superseded native owner")
					}
				})
				if ready {
					release()
					awaitCorePaintWithoutOwnership(t, a, tt, "c")
				}
				coreAppAct(a, func() { a.finishNativeDialog(d, accept, "supplied"); a.finishNativeDialog(d, accept, "duplicate") })
				tt.Frame()
				if accept && (run != 1 || cancel != 0) || !accept && (run != 0 || cancel != 1) {
					t.Fatal("completion count", run, cancel)
				}
				tt.TypeKeyNative(0, ui.KeyX, "x")
				if ready {
					wantCoreInput(t, f, "x")
				} else {
					noCoreData(t, f)
					release()
					awaitCorePaintWithoutOwnership(t, a, tt, "c")
					tt.KeyUnframed(0, ui.KeyEnter)
				}
				noCoreData(t, f)
			})
		}
	}
}
