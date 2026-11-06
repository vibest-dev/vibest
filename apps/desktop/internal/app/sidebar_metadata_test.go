package app

import (
	"reflect"
	"testing"
	"vibest-desktop/internal/core"
)

func TestSidebarEndpointMetadata(t *testing.T) {
	a, f, tt := machineHeaderCoreApp(t)
	check := func() {
		t.Helper()
		tt.Frame()
		for _, s := range []string{"local repo", "remote repo", "remote tree"} {
			r := find(t, tt, s)
			if r.X >= a.sideWidth {
				t.Fatal("sidebar metadata outside column")
			}
		}
		if find(t, tt, "remote tree").X <= find(t, tt, "remote repo").X {
			t.Fatal("explicit repository grouping lost")
		}
		for _, m := range a.machines {
			for _, w := range m.snap.Workspaces {
				if w.Branch != "" || len(w.AheadBehind) != 0 {
					t.Fatal("unreported Git metadata was fabricated")
				}
			}
		}
		if !tt.HasText("activity: done") {
			t.Fatal("local explicit activity lost")
		}
	}
	check()
	for range 3 {
		for _, target := range []string{"Remote/d", "a"} {
			a.ShowNotice(target)
			tt.Frame()
			check()
			if target == "Remote/d" {
				wantRemoteNavigation(t, a, f, tt, "d")
			} else {
				readyCorePane(t, a, tt, "a")
				tt.Type("x")
				wantCorePaneInput(t, f, "a", "x")
			}
		}
	}
	before := a.coreState.Layout
	publishCoreLayout(t, a, f, func(f *coreAppFixture) { f.layout.Workspaces[1].Label = "remote updated" })
	tt.Frame()
	find(t, tt, "remote updated")
	find(t, tt, "local repo")
	if a.coreSelection.Pane != "a" {
		t.Fatal("background metadata navigated")
	}
	if reflect.DeepEqual(before, a.coreState.Layout) {
		t.Fatal("external doc did not replace metadata")
	}
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		f.layout.Workspaces[1].Repository = ""
		f.layout.Workspaces[2].Repository = ""
		f.layout.Workspaces[2].Linked = false
		f.machines[0].State = "disconnected"
	})
	tt.Frame()
	if find(t, tt, "remote tree").X != find(t, tt, "remote updated").X {
		t.Fatal("removed metadata left grouping")
	}
	find(t, tt, "offline")
	find(t, tt, "local repo")
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		f.machines = append(f.machines, core.MachineView{Name: "Unknown", ID: "unknown", State: "connecting"})
	})
	tt.Frame()
	find(t, tt, "machine: Unknown")
	for _, name := range []string{"Local", "Unknown", "Remote"} {
		navigationRelease(t, tt, "machine: "+name)
		tt.Frame()
		find(t, tt, "local repo")
		find(t, tt, "remote updated")
	}
	noCoreData(t, f)
	noLegacyNavigation(t, f)
}
