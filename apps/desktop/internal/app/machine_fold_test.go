package app

import (
	"fmt"
	"reflect"
	"testing"

	"vibest-desktop/internal/core"

	"github.com/egoist/mygo/ui"
)

func machineDisclosureState(t *testing.T, tt *ui.Tester, label string, expanded bool) {
	t.Helper()
	root := reflect.ValueOf(tt).Elem().FieldByName("rt").Elem().FieldByName("c").FieldByName("root")
	var findNode func(reflect.Value) bool
	findNode = func(p reflect.Value) bool {
		if p.IsNil() {
			return false
		}
		n := p.Elem()
		if n.FieldByName("label").String() == label {
			if n.FieldByName("role").Uint() != uint64(ui.RoleDisclosure) || n.FieldByName("expanded").Bool() != expanded {
				t.Fatalf("%s lacks disclosure role/expanded=%v", label, expanded)
			}
			return true
		}
		for ch := n.FieldByName("first"); !ch.IsNil(); ch = ch.Elem().FieldByName("next") {
			if findNode(ch) {
				return true
			}
		}
		return false
	}
	if !findNode(root) {
		t.Fatalf("no semantic disclosure %q", label)
	}
}

func TestMachineDisclosureOnlyChangesPresentation(t *testing.T) {
	a, f, tt := machineHeaderCoreApp(t)
	local, remote := a.machines[0], a.machines[1]
	v := a.coreViews["a"]
	coreAppAct(a, func() { a.toggleFold(local, "/repo/.git"); a.toggleFold(remote, "/repo/.git") })
	tt.Frame()
	for _, owner := range []string{"Local", "Remote"} {
		machineDisclosureState(t, tt, "Collapse machine: "+owner, true)
		if err := tt.Click("Collapse machine: " + owner); err != nil {
			t.Fatal(err)
		}
		machineDisclosureState(t, tt, "Expand machine: "+owner, false)
		if !tt.Focused("terminal/a") {
			t.Fatal("disclosure stole terminal owner")
		}
	}
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		f.layout.Workspaces[0].Label = "updated local"
		f.layout.Workspaces[1].Label = "updated remote"
	})
	reportActivity(t, a, f, "a", "working", 8, true)
	tt.Frame()
	absent(t, tt, "updated local", "updated remote")
	if !a.foldedMachines[local.sidebarID()] || !a.foldedMachines[remote.sidebarID()] || a.coreViews["a"] != v || a.coreSelection.Pane != "a" {
		t.Fatal("fold changed ownership or refresh unfolded")
	}
	tt.Type("x")
	wantCorePaneInput(t, f, "a", "x")
	for _, owner := range []string{"Local", "Remote"} {
		if err := tt.Click("Expand machine: " + owner); err != nil {
			t.Fatal(err)
		}
	}
	find(t, tt, "updated local")
	find(t, tt, "updated remote")
	absent(t, tt, "remote tree")
	if len(coreRequests(f, "terminal.run"))+len(coreRequests(f, "terminal.kill"))+len(coreRequests(f, "doc.set")) != 0 {
		t.Fatal("fold dispatched mutation")
	}
	noLegacyNavigation(t, f)
}

func TestMachineDisclosureKeyboard(t *testing.T) {
	for _, key := range []ui.Key{ui.KeyEnter, ui.KeySpace} {
		t.Run(fmt.Sprint(key), func(t *testing.T) {
			a, local, remote, tt := machineHeaderApp(t)
			generation := a.coreNavigation
			for _, m := range []*machine{local, remote} {
				r := find(t, tt, "machine: "+m.label())
				tt.Press(r.X+r.W/2, r.Y+r.H/2)
				tt.Release(-10, -10)
				tt.Key(0, ui.KeyUp)
				if !tt.Focused("Collapse machine: " + m.label()) {
					t.Fatal("disclosure not keyboard reachable separately from title")
				}
				tt.Key(0, key)
				tt.Frame()
				machineDisclosureState(t, tt, "Expand machine: "+m.label(), false)
				if !tt.Focused("Expand machine: "+m.label()) || a.machine != local || a.coreNavigation != generation {
					t.Fatal("keyboard disclosure navigated or lost intentional keyboard focus")
				}
				tt.Key(0, key)
				tt.Frame()
				machineDisclosureState(t, tt, "Collapse machine: "+m.label(), true)
			}
		})
	}
}

func TestMachineFoldIDsAndLifecycle(t *testing.T) {
	a, f, tt := machineHeaderCoreApp(t)
	local, remote := a.machines[0], a.machines[1]
	if local.sidebarID() == remote.sidebarID() {
		t.Fatal("namespace collision")
	}
	if err := tt.Click("Collapse machine: Remote"); err != nil {
		t.Fatal(err)
	}
	publishCoreLayout(t, a, f, func(f *coreAppFixture) { f.machines[0].State = "disconnected" })
	tt.Frame()
	find(t, tt, "Expand machine: Remote")
	absent(t, tt, "remote repo")
	if err := tt.Click("Collapse machine: Local"); err != nil {
		t.Fatal(err)
	}
	publishCoreLayout(t, a, f, func(f *coreAppFixture) { f.machines = nil; f.layout.Workspaces = f.layout.Workspaces[:1] })
	tt.Frame()
	find(t, tt, "machine: Local")
	find(t, tt, "Expand machine: Local")
	if a.foldedMachines[remote.sidebarID()] || !a.foldedMachines[local.sidebarID()] {
		t.Fatal("removed machine fold leaked or erased local")
	}
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		f.machines = []core.MachineView{{Name: "Remote", ID: "remote-A", State: "connected"}}
		p := core.NewPane(core.TerminalRef{CoreID: "remote-A", Address: "Remote/s"})
		f.layout.AddWorkspace("again", "", "Remote", p)
	})
	tt.Frame()
	find(t, tt, "Collapse machine: Remote")
	find(t, tt, "again")
	absent(t, tt, "local repo")
	if err := tt.Click("Expand machine: Local"); err != nil {
		t.Fatal(err)
	}
	find(t, tt, "local repo")
}

func TestFoldedMachineTitleStillNavigates(t *testing.T) {
	a, f, tt := machineHeaderCoreApp(t)
	publishCoreLayout(t, a, f, func(f *coreAppFixture) { f.machines[0].State = "disconnected" })
	tt.Frame()
	if err := tt.Click("Collapse machine: Remote"); err != nil {
		t.Fatal(err)
	}
	find(t, tt, "offline")
	if a.machine.id() != "" {
		t.Fatal("disclosure navigated")
	}
	if err := tt.Click("machine: Remote"); err != nil {
		t.Fatal(err)
	}
	if a.machine.id() != "Remote" || !a.foldedMachines[a.machine.sidebarID()] {
		t.Fatal("folded title lost navigation")
	}
	a.ShowNotice("Remote/d")
	tt.Frame()
	find(t, tt, "Expand machine: Remote")
	noCoreData(t, f)
}
