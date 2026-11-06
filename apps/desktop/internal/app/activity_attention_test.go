package app

import "testing"

func TestActivityOfflineAndAttention(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	reportActivity(t, a, f, "c", "blocked", 0, true)
	coreAppAct(a, func() {
		if status, description := a.machine.activity(activityScope{pane: "c"}); status != "" || description != "Needs attention (reported)" {
			t.Fatalf("%q/%q", status, description)
		}
	})
	reportActivity(t, a, f, "c", "blocked", 3, true)
	coreAppAct(a, func() {
		if status, _ := a.machine.activity(activityScope{pane: "c"}); status != "done" {
			t.Fatal("reported historical completion lost")
		}
	})
	f.peer.Close()
	awaitCoreApp(t, a, func() bool { return !a.machine.connected })
	coreAppAct(a, func() {
		if status, description := a.machine.activity(activityScope{pane: "c"}); status != "" || description != "Offline" {
			t.Fatalf("%q/%q", status, description)
		}
	})
}
func TestFirstUnreportedCoreSnapshotDoesNotSeedLaterTurns(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		coreActivitySeed(f)
		for id, r := range f.terminals {
			r.Reported = false
			r.Status = nil
			r.Turn = 0
			f.terminals[id] = r
		}
	})
	coreAppAct(a, func() { a.SelectWorkspace("w1") })
	wantCoreSeen(t, a, map[string]uint64{})
	reportActivity(t, a, f, "a", "idle", 1, true)
	coreAppAct(a, func() {
		if status, _ := a.machine.activity(activityScope{pane: "a"}); status != "done" {
			t.Fatal("later reported turn seeded as already seen")
		}
	})
}
