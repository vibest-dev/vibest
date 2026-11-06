package app

import (
	"testing"
	"vibest-desktop/internal/core"
)

func TestCompletionAcknowledgments(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	var visit coreVisit
	coreAppAct(a, func() { visit = a.captureCoreVisit(activityScope{tab: "t1"}) })
	reportActivity(t, a, f, "a", "done", 4, true)
	coreAppAct(a, func() { a.acknowledgeCoreVisit(visit) })
	wantCoreSeen(t, a, map[string]uint64{"b": 2})
	reportActivity(t, a, f, "b", "unknown", 0, false)
	wantCoreSeen(t, a, map[string]uint64{"b": 2})
	reportActivity(t, a, f, "b", "idle", 2, true)
	wantCoreSeen(t, a, map[string]uint64{"b": 2})
	f.report("restarted", core.Terminal{Address: "b", Reported: true, Status: &core.Status{State: "done"}, Turn: 2})
	awaitCoreApp(t, a, func() bool { return a.coreState.Programs["b"] == 1 })
	coreAppAct(a, func() { a.acknowledgeCoreVisit(visit) })
	wantCoreSeen(t, a, map[string]uint64{})
}
func TestCompletionVisitIndependentWindowsAndRemoval(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	other, _ := newCoreAppFixtureWith(t, coreActivitySeed)
	var visit coreVisit
	coreAppAct(a, func() { visit = a.captureCoreVisit(activityScope{pane: "b"}); a.ShowPane("b") })
	wantCoreSeen(t, a, map[string]uint64{"b": 2})
	wantCoreSeen(t, other, map[string]uint64{})
	coreAppAct(other, func() { other.acknowledgeCoreVisit(visit) })
	wantCoreSeen(t, other, map[string]uint64{})
	reconnectCoreApp(t, a, f, coreActivitySeed)
	coreAppAct(a, func() { a.acknowledgeCoreVisit(visit) })
	wantCoreSeen(t, a, map[string]uint64{})
}
