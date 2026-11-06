package app

import (
	"testing"
	"vibest-desktop/internal/core"

	"github.com/egoist/mygo/ui"
)

func machinesCoreApp(t *testing.T) (*App, *coreAppFixture, *ui.Tester) {
	a, f, tt := coreMachineUI(t)
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		f.layout.Workspaces = nil
		add := func(id, label, key, machine, address string, linked bool) {
			owner := f.layout.CoreID
			if machine != "" {
				owner = "remote-A"
				f.terminals[owner+"/"+address] = core.Terminal{Address: "Remote/" + address, State: "live", Cols: 80, Rows: 24}
				address = "Remote/" + address
			}
			p := core.NewPane(core.TerminalRef{CoreID: owner, Address: address})
			f.layout.AddWorkspace(label, "", machine, p)
			w := &f.layout.Workspaces[len(f.layout.Workspaces)-1]
			w.ID = id
			w.Repository = key
			w.Linked = linked
		}
		add("lp", "lparent", "/r/.git", "", "a", false)
		add("lc", "lchild", "/r/.git", "", "b", true)
		for _, w := range []struct {
			id, key string
			linked  bool
		}{{"rp", "/r/.git", false}, {"rn", "", false}, {"rc", "/r/.git", true}, {"rs", "/s/.git", false}, {"ro", "/o/.git", true}} {
			labels := map[string]string{"rp": "rparent", "rn": "rnotes", "rc": "rchild", "rs": "rsolo", "ro": "rorphan"}
			add(w.id, labels[w.id], w.key, "Remote", w.id, w.linked)
		}
	})
	tt.Frame()
	readyCorePane(t, a, tt, a.coreSelection.Pane)
	return a, f, tt
}
func machinesApp(t *testing.T) (*App, *machine, *ui.Tester) {
	a, _, tt := machinesCoreApp(t)
	return a, a.machines[1], tt
}

func find(t *testing.T, tt *ui.Tester, s string) ui.Rect {
	t.Helper()
	r, ok := tt.Find(s)
	if !ok {
		t.Fatalf("%q not shown in %v", s, tt.Texts())
	}
	return r
}

func checkRemoteGrouped(t *testing.T, tt *ui.Tester) {
	t.Helper()
	order := []string{"rparent", "rchild", "rnotes", "rsolo", "rorphan"}
	for i := 1; i < len(order); i++ {
		if find(t, tt, order[i-1]).Y >= find(t, tt, order[i]).Y {
			t.Fatalf("%s is not above %s", order[i-1], order[i])
		}
	}
	x := find(t, tt, "rparent").X
	if find(t, tt, "rchild").X <= x {
		t.Fatal("the linked worktree is not indented")
	}
	for _, s := range []string{"rnotes", "rsolo", "rorphan"} {
		if find(t, tt, s).X != x {
			t.Fatalf("%s is not a single row", s)
		}
	}
}

func foldSlot(t *testing.T, tt *ui.Tester, parent string) {
	t.Helper()
	r := find(t, tt, parent)
	tt.ClickAt(r.X-12, r.Y+r.H/2)
	tt.Frame()
}

func TestOtherMachineGroupsBeforeShown(t *testing.T) {
	app, _, tt := machinesApp(t)
	checkRemoteGrouped(t, tt)

	foldSlot(t, tt, "rparent")
	if tt.HasText("rchild") || !tt.HasText("lchild") {
		t.Fatalf("folding the machine's group: %v", tt.Texts())
	}
	if app.machine != app.machines[0] {
		t.Fatal("folding showed the machine")
	}
	foldSlot(t, tt, "lparent")
	if tt.HasText("lchild") || tt.HasText("rchild") {
		t.Fatalf("both groups folded: %v", tt.Texts())
	}
	foldSlot(t, tt, "rparent")
	if !tt.HasText("rchild") || tt.HasText("lchild") {
		t.Fatalf("unfolding the machine's group: %v", tt.Texts())
	}
}

func TestGroupsStayWhenTheShownMachineChanges(t *testing.T) {
	app, mini, tt := machinesApp(t)
	local := func() {
		t.Helper()
		if find(t, tt, "lchild").X <= find(t, tt, "lparent").X {
			t.Fatal("this computer's group is flat")
		}
	}
	local()
	app.mu.Lock()
	app.coreActivateMachine(mini)
	app.mu.Unlock()
	tt.Frame()
	checkRemoteGrouped(t, tt)
	local()
	app.mu.Lock()
	app.coreActivateMachine(app.machines[0])
	app.mu.Unlock()
	tt.Frame()
	checkRemoteGrouped(t, tt)
	local()
}

func TestClickOnOtherMachinesWorktreeShowsThatMachine(t *testing.T) {
	a, f, tt := machinesCoreApp(t)
	if err := tt.Click("rchild"); err != nil {
		t.Fatal(err)
	}
	if a.machine.id() != "Remote" || a.coreSelection.Workspace != "rc" {
		t.Fatal("other machine row selected wrong identity")
	}
	wantRemoteNavigation(t, a, f, tt, a.coreSelection.Pane)
	noLegacyNavigation(t, f)
}

func TestOtherMachineGroupsFollowItsSnapshot(t *testing.T) {
	a, f, tt := machinesCoreApp(t)
	publishCoreLayout(t, a, f, func(f *coreAppFixture) { f.machines[0].State = "disconnected" })
	tt.Frame()
	checkRemoteGrouped(t, tt)
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		for i := range f.layout.Workspaces {
			if f.layout.Workspaces[i].Machine == "Remote" {
				f.layout.Workspaces[i].Repository = ""
				f.layout.Workspaces[i].Linked = false
			}
		}
	})
	tt.Frame()
	order := []string{"rparent", "rnotes", "rchild", "rsolo", "rorphan"}
	x := find(t, tt, order[0]).X
	for i := 1; i < len(order); i++ {
		if find(t, tt, order[i-1]).Y >= find(t, tt, order[i]).Y || find(t, tt, order[i]).X != x {
			t.Fatal("unknown grouping retained stale metadata")
		}
	}
	noCoreData(t, f)
}

func TestRemovedMachineForgetsItsFolds(t *testing.T) {
	a, f, tt := machinesCoreApp(t)
	foldSlot(t, tt, "rparent")
	absent(t, tt, "rchild")
	var saved []core.Workspace
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		saved = append(saved, f.layout.Workspaces[2:]...)
		f.layout.Workspaces = f.layout.Workspaces[:2]
		f.machines = nil
	})
	tt.Frame()
	if len(a.machines) != 1 || a.collapsed["Remote"] != nil {
		t.Fatal("removed machine retains folds")
	}
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		f.machines = []core.Machine{{Name: "Remote", ID: "remote-A", State: "connected"}}
		f.layout.Workspaces = append(f.layout.Workspaces, saved...)
	})
	tt.Frame()
	checkRemoteGrouped(t, tt)
	noCoreData(t, f)
}
