package app

import (
	"reflect"
	"slices"
	"testing"
	"vibest-desktop/internal/core"
)

func TestTerminalsMenuFollowsEndpointMetadata(t *testing.T) {
	a, f, tt := machineHeaderCoreApp(t)
	check := func(names ...string) {
		t.Helper()
		tt.Frame()
		if err := tt.Click("Terminals"); err != nil {
			t.Fatal(err)
		}
		for _, name := range names {
			if !slices.Contains(tt.Menu(), name) {
				t.Fatalf("%s absent from %v", name, tt.Menu())
			}
		}
		tt.CloseMenu()
		for _, m := range a.machines {
			for _, w := range m.snap.Workspaces {
				if w.Branch != "" || len(w.AheadBehind) != 0 {
					t.Fatal("unreported Git metadata was fabricated")
				}
			}
		}
	}
	check("local repo", "remote repo", "remote tree")
	for range 3 {
		for _, target := range []string{"Remote/d", "a"} {
			a.ShowNotice(target)
			tt.Frame()
			check("local repo", "remote repo", "remote tree")
			a.ShowNotice(target)
			tt.Frame()
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
	check("local repo", "remote updated")
	if a.coreSelection.Pane != "a" || reflect.DeepEqual(before, a.coreState.Layout) {
		t.Fatal("background metadata navigated or was not refreshed")
	}
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		f.layout.Workspaces[1].Repository = ""
		f.layout.Workspaces[2].Repository = ""
		f.layout.Workspaces[2].Linked = false
		f.machines[0].State = "disconnected"
		f.machines = append(f.machines, core.MachineView{Name: "Unknown", ID: "unknown", State: "connecting"})
	})
	check("local repo", "remote updated", "remote tree")
	absent(t, tt, "machine: Local", "machine: Remote", "machine: Unknown", "local repo", "remote tree")
	noCoreData(t, f)
	noLegacyNavigation(t, f)
}
