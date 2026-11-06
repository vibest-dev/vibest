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
func find(t *testing.T, tt *ui.Tester, s string) ui.Rect {
	t.Helper()
	r, ok := tt.Find(s)
	if !ok {
		t.Fatalf("%q not shown in %v", s, tt.Texts())
	}
	return r
}

func TestClickOnOtherMachinesWorktreeShowsThatMachine(t *testing.T) {
	a, f, tt := machinesCoreApp(t)
	if err := tt.Click("Terminals"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("rchild", "Open"); err != nil {
		t.Fatal(err)
	}
	if a.machine.id() != "Remote" || a.coreSelection.Workspace != "rc" {
		t.Fatal("other machine row selected wrong identity")
	}
	wantRemoteNavigation(t, a, f, tt, a.coreSelection.Pane)
	noLegacyNavigation(t, f)
}
