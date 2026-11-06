package app

import (
	"testing"
	"vibest-desktop/internal/core"
)

func TestCompletionZeroCoreTurnAndImmutableSnapshot(t *testing.T) {
	a, _ := newCoreAppFixtureWith(t, func(f *coreAppFixture) { coreActivitySeed(f); r := f.terminals["b"]; r.Turn = 0; f.terminals["b"] = r })
	coreAppAct(a, func() {
		s := a.coreSession.State()
		r := s.Terminals["b"]
		r.Turn = 99
		s.Terminals["b"] = r
		s.Programs["b"] = 99
		if a.coreSession.State().Terminals["b"].Turn != 0 || a.coreSession.State().Programs["b"] != 0 {
			t.Fatal("published snapshot aliased Session state")
		}
		a.ShowPane("b")
		if status, _ := a.machine.activity(activityScope{pane: "b"}); status != "" {
			t.Fatal("zero count manufactured a completion token")
		}
	})
	wantCoreSeen(t, a, map[string]uint64{})
}
func TestActivityUnreportedCoreRecordDoesNotBecomeCompletion(t *testing.T) {
	a, _ := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		coreActivitySeed(f)
		f.terminals["b"] = core.Terminal{Address: "b", Status: &core.Status{State: "done"}, Turn: 99}
	})
	coreAppAct(a, func() {
		a.ShowPane("b")
		if status, description := a.machine.activity(activityScope{pane: "b"}); status != "" || description != "Activity unknown" {
			t.Fatalf("%q/%q", status, description)
		}
	})
	wantCoreSeen(t, a, map[string]uint64{})
}
func TestActivityScopeWorkingOverridesCompletion(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	reportActivity(t, a, f, "a", "working", 1, true)
	coreAppAct(a, func() {
		for _, scope := range []activityScope{{workspace: "w1"}, {tab: "t1"}} {
			if status, _ := a.machine.activity(scope); status != "working" {
				t.Fatalf("actual work hidden in %+v", scope)
			}
		}
		if status, _ := a.machine.activity(activityScope{tab: "t2"}); status != "done" {
			t.Fatal("unrelated work hid completion")
		}
	})
	reportActivity(t, a, f, "a", "done", 2, true)
	coreAppAct(a, func() {
		for _, scope := range []activityScope{{workspace: "w1"}, {tab: "t1"}} {
			if status, _ := a.machine.activity(scope); status != "done" {
				t.Fatalf("completion lost in %+v", scope)
			}
		}
	})
}
func TestActivityReconnectAndDeletion(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	coreAppAct(a, func() { a.ShowPane("b") })
	wantCoreSeen(t, a, map[string]uint64{"b": 2})
	f = reconnectCoreApp(t, a, f, coreActivitySeed)
	wantCoreSeen(t, a, map[string]uint64{})
	coreAppAct(a, func() { a.ShowPane("b") })
	wantCoreSeen(t, a, map[string]uint64{"b": 2})
	f.report("removed", core.Terminal{Address: "b"})
	awaitCoreApp(t, a, func() bool { _, exists := a.coreState.Terminals["b"]; return !exists })
	wantCoreSeen(t, a, map[string]uint64{})
	f.report("created", core.Terminal{Address: "b", Reported: true, Status: &core.Status{State: "done"}, Turn: 2})
	awaitCoreApp(t, a, func() bool { return a.coreState.Terminals["b"].Reported })
	coreAppAct(a, func() {
		if status, _ := a.machine.activity(activityScope{pane: "b"}); status != "done" {
			t.Fatal("replacement inherited acknowledgment")
		}
	})
}
