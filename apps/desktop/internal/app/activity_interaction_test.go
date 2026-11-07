package app

import (
	"strings"
	"testing"
)

func TestActivityTabCloseRetainsItsSlotAndDoesNotVisit(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	tab, name := find(t, tt, "tab/t1"), find(t, tt, "Build")
	before := strings.Count(strings.Join(tt.Texts(), "\n"), "activity: done")
	tt.Move(name.X+4, name.Y+name.H/2)
	close := find(t, tt, "close/t1")
	if close.W != a.th.Slot || close.H != a.th.Slot || close.X != tab.X+tab.W-10-a.th.Slot {
		t.Fatalf("close moved: %v/%v", tab, close)
	}
	if got := strings.Count(strings.Join(tt.Texts(), "\n"), "activity: done"); got != before-1 {
		t.Fatal("hover replaced more than the tab indicator")
	}
	tt.ClickAt(close.X+close.W/2, close.Y+close.H/2)
	wantCoreSeen(t, a, map[string]uint64{})
	f.mu.Lock()
	for _, method := range f.methods {
		if method == "terminal.kill" || method == "doc.set" {
			t.Error("close changed resources without confirmation")
		}
	}
	f.mu.Unlock()
	if err := tt.Click("Cancel"); err != nil {
		t.Fatal(err)
	}
	tt.Move(-10, -10)
	if err := tt.Click("Build"); err != nil {
		t.Fatal(err)
	}
	wantCoreSeen(t, a, map[string]uint64{"a": 1, "b": 2})
}
func TestActivityReportMissingAtAcknowledgmentIsConservative(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	var visit coreVisit
	coreAppAct(a, func() { visit = a.captureCoreVisit(activityScope{pane: "b"}) })
	reportActivity(t, a, f, "b", "", 0, false)
	coreAppAct(a, func() { a.acknowledgeCoreVisit(visit) })
	wantCoreSeen(t, a, map[string]uint64{})
	reportActivity(t, a, f, "b", "done", 2, true)
	coreAppAct(a, func() {
		if status, _ := a.machine.activity(activityScope{pane: "b"}); status != "done" {
			t.Fatal("missing report consumed a later count")
		}
	})
}
func TestActivityContextMenuDoesNotVisit(t *testing.T) {
	a, _, tt := coreActivityUI(t)
	applyVibest(a, shippingSnapshot(vibestSession("main", "lead", "p1", "done", "a", nil, 1)))
	tt.Frame()
	status := sidebarActivity(t, tt, "Shipping")
	tt.RightClickAt(status.X+status.W/2, status.Y+status.H/2)
	if len(tt.Menu()) == 0 {
		t.Fatal("passive activity swallowed context menu")
	}
	wantCoreSeen(t, a, map[string]uint64{})
	tt.CloseMenu()
}
