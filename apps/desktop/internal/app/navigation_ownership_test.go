package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
)

func TestNavigationOldBootQueuedBeforeTransportIsInvalidated(t *testing.T) {
	a, f, tt, b, release := blockedCoreUI(t, "anchor", false)
	_, healthy, other := coreActivityUI(t)
	f.mu.Lock()
	oldChannel := f.channels["a"]
	f.mu.Unlock()
	tt.Type("anchor")
	waitCoreWrite(t, b)
	tt.Type("x")
	tt.KeyUnframed(0, ui.KeyEnter)
	f.mu.Lock()
	r := f.terminals["a"]
	f.mu.Unlock()
	f.report("restarted", r)
	awaitCoreApp(t, a, func() bool { return a.coreState.Programs["a"] == 1 })
	other.Type("y")
	wantCorePaneInput(t, healthy, "a", "y")
	release()
	if got := wantCoreInput(t, f, "anchor"); got != oldChannel {
		t.Fatal("already-admitted bytes changed channel")
	}
	readyCorePane(t, a, tt, "a")
	tt.Type("q")
	wantCorePaneInput(t, f, "a", "q")
	noCoreData(t, f)
}
func TestNavigationAgentPaneFocusCapturesUntilACKAndPaneSurface(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	release, held := holdCoreMethod(t, f, "terminal.attach c")
	f.mu.Lock()
	r := f.terminals["c"]
	f.mu.Unlock()
	r.Turn = 7
	f.report("status", r)
	awaitCoreApp(t, a, func() bool { return a.coreState.Terminals["c"].Turn == 7 })
	a.ShowNotice("c")
	tt.Frame()
	<-held
	tt.TypeKeyNative(0, ui.KeyX, "x")
	noCoreData(t, f)
	wantCoreSeen(t, a, map[string]uint64{"c": 7})
	release()
	readyCorePane(t, a, tt, "c")
	wantCorePaneInput(t, f, "c", "x")
	tt.Type("y")
	wantCorePaneInput(t, f, "c", "y")
	noLegacyNavigation(t, f)
}
func TestNavigationDeferredRPCOutcomeKeepsNewIntentOrFailsConnection(t *testing.T) {
	for _, outcome := range []string{"success", "refusal", "connection-failure"} {
		t.Run(outcome, func(t *testing.T) {
			a, f, tt, _, releaseOld := pendingCoreNavigation(t)
			tt.Type("xy")
			releaseNew, held := holdCoreMethod(t, f, "terminal.attach d")
			coreAppAct(a, func() { a.ShowPane("d") })
			tt.Frame()
			<-held
			tt.Type("z")
			n := a.coreCapture
			if n == nil || n.count != 1 {
				t.Fatal("new intent missing")
			}
			if outcome == "connection-failure" {
				_, healthy, other := coreActivityUI(t)
				f.peer.Close()
				awaitCoreApp(t, a, func() bool { return a.coreCapture == nil })
				if n.events != nil {
					t.Fatal("disconnect retained input")
				}
				other.Type("q")
				wantCorePaneInput(t, healthy, "a", "q")
				noCoreData(t, f)
				return
			}
			if outcome == "refusal" {
				f.mu.Lock()
				f.failOnce = map[string]string{"terminal.attach c": "denied"}
				f.mu.Unlock()
			}
			releaseOld()
			awaitCoreApp(t, a, func() bool { return !a.coreLoading["c"] })
			if a.coreCapture != n || n.count != 1 {
				t.Fatal("old completion canceled new intent")
			}
			releaseNew()
			readyCorePane(t, a, tt, "d")
			wantCorePaneInput(t, f, "d", "z")
			noCoreData(t, f)
		})
	}
}
func TestNavigationOldNoticeDismissCannotEraseNewCancellation(t *testing.T) {
	a, f, tt, _, release := pendingCoreNavigation(t)
	tt.Type("x")
	tt.Key(ui.Cmd, ui.KeyK)
	if err := tt.Click("tab/t2"); err != nil {
		t.Fatal(err)
	}
	tt.Type("z")
	n := a.coreCapture
	if n == nil || n.count != 1 {
		t.Fatal("fresh z capture missing")
	}
	if err := tt.Click("Dismiss"); err != nil {
		t.Fatal(err)
	}
	if !notes(tt, navigationLost) || n.events != nil || !a.coreBlocked {
		t.Fatal("old dismissal erased new cancellation")
	}
	release()
	awaitCorePaintWithoutOwnership(t, a, tt, "c")
	tt.TypeKeyNative(0, ui.KeyQ, "q")
	noCoreData(t, f)
}
func TestNavigationRawReadySupersedeKeepsRenderedCancellation(t *testing.T) {
	a, f, tt, n, release := pendingCoreNavigation(t)
	tt.TypeKeyNative(0, ui.KeyX, "x")
	tt.TypeKeyNative(0, ui.KeyY, "y")
	if n.count != 2 {
		t.Fatal("retained x/y missing")
	}
	r := find(t, tt, "tab/t1")
	tt.PressUnframed(r.X+r.W/2, r.Y+r.H/2)
	tt.ReleaseUnframed(r.X+r.W/2, r.Y+r.H/2)
	readyCorePane(t, a, tt, "a")
	if !notes(tt, navigationLost) || n.events != nil || a.coreCapture != nil {
		t.Fatal("ready handoff erased loss")
	}
	noCoreData(t, f)
	if err := tt.Click("Dismiss"); err != nil {
		t.Fatal(err)
	}
	if notes(tt, navigationLost) {
		t.Fatal("loss not dismissed")
	}
	release()
}
