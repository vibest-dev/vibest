package app

import (
	"encoding/json"
	"testing"

	"vibest-desktop/internal/core"
	"vibest-desktop/internal/project"
)

func TestProjectSidebarGroupsAndOpensTerminal(t *testing.T) {
	name := func(s string) *string { return &s }
	kind := "permission"
	a, _, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		f.projects = project.File{Schema: 1, Projects: []project.Project{{ID: "p1", Name: "Shipping", Core: "app-fixture", CWD: "/proj"}}}
		f.layout.Workspaces[1].Project = "p1"
		set := func(addr, n string, st *core.Status, labels map[string]string) {
			r := f.terminals[addr]
			r.Name, r.Status, r.Labels = name(n), st, labels
			f.terminals[addr] = r
		}
		in := map[string]string{project.Label("p1"): "1"}
		set("a", "alpha", &core.Status{State: "working"}, in)
		set("b", "beta", &core.Status{State: "blocked", Kind: &kind}, in)
		set("d", "delta", &core.Status{State: "idle"}, nil)
	})
	awaitCoreApp(t, a, func() bool { return len(a.projects.Projects) == 1 })
	tt.Frame()
	for _, s := range []string{"Projects", "Shipping", "1 waiting", "1 working", "Needs permission", "alpha", "beta", "Unassigned", "delta"} {
		if !tt.HasText(s) {
			t.Fatalf("%q not shown in %v", s, tt.Texts())
		}
	}
	if find(t, tt, "beta").Y >= find(t, tt, "alpha").Y {
		t.Fatal("waiting terminal does not sort first")
	}
	if err := tt.Click("delta"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.coreSelection.Pane != "d" {
		t.Fatalf("click selected pane %q, want d", a.coreSelection.Pane)
	}
}

func TestProjectOwnsWorkspaceAndCreatesItsTerminals(t *testing.T) {
	a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		f.projects = project.File{Schema: 1, Projects: []project.Project{{ID: "p1", Name: "Shipping", Core: "app-fixture", CWD: "/proj"}}}
		f.layout.Workspaces[1].Project = "p1"
		n := "echo"
		f.terminals["e"] = core.Terminal{Address: "e", Name: &n, State: "live", Cols: 80, Rows: 24, Labels: map[string]string{project.Label("p1"): "1"}}
	})
	awaitCoreApp(t, a, func() bool { return len(a.projects.Projects) == 1 })
	tt.Frame()
	tabs := func() int {
		for _, w := range a.coreState.Layout.Workspaces {
			if w.ID == "w2" {
				return len(w.Tabs)
			}
		}
		return 0
	}
	if !tt.HasText("Repo") {
		t.Fatalf("unassigned workspace lost: %v", tt.Texts())
	}
	if tt.HasText("Other") {
		t.Fatalf("Project workspace still listed as a plain workspace: %v", tt.Texts())
	}
	if err := tt.Click("Shipping"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.coreSelection.Workspace != "w2" {
		t.Fatalf("selecting the Project showed %q, want w2", a.coreSelection.Workspace)
	}
	if err := tt.Click("echo"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return tabs() == 2 })
	if err := tt.Click("New terminal in Shipping"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return tabs() == 3 })
	runs := coreRequests(f, "terminal.run")
	if len(runs) != 1 {
		t.Fatalf("runs: %d", len(runs))
	}
	var got struct {
		CWD    string
		Keep   bool
		Labels map[string]string
	}
	json.Unmarshal(runs[0], &got)
	if got.CWD != "/proj" || !got.Keep || got.Labels[project.Label("p1")] != "1" {
		t.Fatalf("run params %s", runs[0])
	}
}

func TestNewProjectFromOneFolderPick(t *testing.T) {
	a, f, tt := coreActivityUIWith(t, nil)
	var start string
	var pick func(string)
	a.folderPicker = func(s string, run func(string)) bool { start, pick = s, run; return true }
	if err := tt.Click("New project"); err != nil {
		t.Fatal(err)
	}
	if pick == nil {
		t.Fatal("the folder chooser was not offered")
	}
	a.mu.Lock()
	pick("/work/shiny/")
	a.mu.Unlock()
	awaitCoreApp(t, a, func() bool { return len(a.projects.Projects) == 1 })
	p := a.projects.Projects[0]
	if p.Name != "shiny" || p.CWD != "/work/shiny" || p.Core != "app-fixture" {
		t.Fatalf("project %+v (chooser started at %q)", p, start)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if doc, ok := f.projects.(project.File); !ok || len(doc.Projects) != 1 {
		t.Fatalf("document not written: %+v", f.projects)
	}
}
