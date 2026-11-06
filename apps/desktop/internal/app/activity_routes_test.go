package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"
)

func TestActivityExplicitVisitRoutes(t *testing.T) {
	for _, route := range []string{"workspace-pointer", "workspace-indicator", "workspace-enter", "workspace-space", "workspace-other", "tab-pointer", "tab-enter", "tab-space", "tab-number", "tab-next", "notification", "pane-reactivation"} {
		t.Run(route, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			want := map[string]uint64{}
			row, target := "", "a"
			switch route {
			case "workspace-pointer", "workspace-indicator", "workspace-enter", "workspace-space":
				row = "Repo"
				want = map[string]uint64{"a": 1, "b": 2, "c": 3}
			case "tab-pointer", "tab-enter", "tab-space", "tab-number":
				row = "tab/t1"
				want = map[string]uint64{"a": 1, "b": 2}
			case "workspace-other":
				row, target = "Other", "d"
				want = map[string]uint64{"d": 4}
			case "tab-next":
				target = "c"
				want = map[string]uint64{"c": 3}
			case "notification":
				target = "b"
				want = map[string]uint64{"b": 2}
			case "pane-reactivation":
				want = map[string]uint64{"a": 1}
			}
			switch route {
			case "workspace-indicator":
				r := sidebarActivity(t, tt, "Repo")
				tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
			case "tab-number":
				tt.Key(ui.Cmd, ui.Key1)
			case "tab-next":
				tt.Key(ui.Cmd|ui.Shift, ui.KeyBracketRight)
			case "notification":
				a.ShowNotice("b")
			case "pane-reactivation":
				if err := tt.Click("terminal/a"); err != nil {
					t.Fatal(err)
				}
			case "workspace-enter", "workspace-space", "tab-enter", "tab-space":
				focusNavigationControl(t, tt, row)
				wantCoreSeen(t, a, map[string]uint64{})
				key := ui.KeyEnter
				if route == "workspace-space" || route == "tab-space" {
					key = ui.KeySpace
				}
				tt.Key(0, key)
			default:
				if err := tt.Click(row); err != nil {
					t.Fatal(err)
				}
			}
			readyCorePane(t, a, tt, target)
			wantCoreSeen(t, a, want)
			noLegacyNavigation(t, f)
			if !tt.Focused("terminal/" + target) {
				t.Fatal("visit stole terminal focus")
			}
			tt.Type("after visit")
			wantCoreInput(t, f, "after visit")
			coreAppAct(a, func() {
				if a.coreSelection.Pane != target {
					t.Fatalf("selected %+v", a.coreSelection)
				}
				for i, id := range []string{"a", "b", "c", "d"} {
					if a.coreState.Terminals[id].Turn != uint64(i+1) {
						t.Fatal("visit mutated reported count")
					}
				}
			})
		})
	}
}
func TestActivityNavigationSuccessAndCapturedTokens(t *testing.T) {
	for _, scope := range []activityScope{{workspace: "w2"}, {tab: "t2"}, {pane: "b"}} {
		a, f := newCoreAppFixtureWith(t, coreActivitySeed)
		var visit coreVisit
		coreAppAct(a, func() { visit = a.captureCoreVisit(scope) })
		for _, id := range []string{"a", "b", "c", "d"} {
			reportActivity(t, a, f, id, "done", 42, true)
		}
		coreAppAct(a, func() { a.acknowledgeCoreVisit(visit) })
		wantCoreSeen(t, a, map[string]uint64{})
	}
}
func TestActivityFailedNavigationKeepsKnownCompletion(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	coreAppAct(a, func() {
		a.ShowPane("missing")
		a.SelectTab("missing")
		a.SelectWorkspace("missing")
		if !a.corePending || a.coreSelection.Pane != "a" {
			t.Fatal("invalid navigation changed target or retained input ownership")
		}
	})
	wantCoreSeen(t, a, map[string]uint64{})
	f.peer.Close()
	awaitCoreApp(t, a, func() bool { return !a.connected })
	coreAppAct(a, func() { a.ShowPane("b") })
	wantCoreSeen(t, a, map[string]uint64{})
}
func TestActivityDirectionalVisits(t *testing.T) {
	for _, direction := range []string{"right", "left", "invalid"} {
		t.Run(direction, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			coreAppAct(a, func() { a.FocusDirection("a", direction) })
			target, want := "a", map[string]uint64{}
			if direction == "right" {
				target = "b"
				want["b"] = 2
			}
			readyCorePane(t, a, tt, target)
			wantCoreSeen(t, a, want)
			tt.Type("direction")
			wantCoreInput(t, f, "direction")
			noLegacyNavigation(t, f)
		})
	}
}
func TestActivityRemoteReportsCannotAcknowledgePinnedPane(t *testing.T) {
	a, _ := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		coreActivitySeed(f)
		w := &f.layout.Workspaces[1]
		w.Machine = "remote"
		w.Tabs[0].Root.Pane.Terminal = core.TerminalRef{CoreID: "remote-A", Address: "remote/d"}
		f.machines = []core.Machine{{Name: "remote", ID: "remote-A", State: "connected"}}
		f.terminals["remote/d"] = core.Terminal{Address: "remote/d", Reported: true, Status: &core.Status{State: "done"}, Turn: 99}
	})
	coreAppAct(a, func() {
		a.ShowPane("d")
		if status, description := a.machine.activity(activityScope{pane: "d"}); status != "" || description != "Activity unknown" {
			t.Fatalf("alias report borrowed: %q/%q", status, description)
		}
	})
	wantCoreSeen(t, a, map[string]uint64{})
}
func TestActivityNonVisitsAndNewRun(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	tt.Move(100, 100)
	tt.SetSize(1000, 700)
	a.Focus(false)
	a.Focus(true)
	readyCorePane(t, a, tt, "a")
	for _, id := range []string{"a", "b", "c", "d"} {
		reportActivity(t, a, f, id, "idle", map[string]uint64{"a": 1, "b": 2, "c": 3, "d": 4}[id], true)
	}
	wantCoreSeen(t, a, map[string]uint64{})
	coreAppAct(a, func() { a.ShowPane("b") })
	reportActivity(t, a, f, "b", "working", 2, true)
	coreAppAct(a, func() {
		if status, _ := a.machine.activity(activityScope{tab: "t1"}); status != "working" {
			t.Fatal("work did not override completion")
		}
	})
	reportActivity(t, a, f, "b", "done", 22, true)
	coreAppAct(a, func() {
		if status, _ := a.machine.activity(activityScope{pane: "b"}); status != "done" {
			t.Fatal("new count inherited acknowledgment")
		}
	})
}
func TestActivityRetargetDropsCapturedVisit(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	var visit coreVisit
	coreAppAct(a, func() { visit = a.captureCoreVisit(activityScope{pane: "b"}) })
	reconnectCoreApp(t, a, f, coreActivitySeed)
	coreAppAct(a, func() { a.acknowledgeCoreVisit(visit) })
	wantCoreSeen(t, a, map[string]uint64{})
}
func sidebarActivity(t *testing.T, tt *ui.Tester, row string) ui.Rect {
	t.Helper()
	name := find(t, tt, row)
	side := find(t, tt, "sidebar")
	w := chrome.Light.Slot
	return ui.Rect{X: side.X + side.W - chrome.Step12 - w, Y: name.Y + (name.H-w)/2, W: w, H: w}
}
