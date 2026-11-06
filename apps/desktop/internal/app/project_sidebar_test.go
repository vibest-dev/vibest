package app

import (
	"encoding/json"
	"testing"

	"vibest-desktop/internal/core"
	"vibest-desktop/internal/vibest"
	"vibest-desktop/internal/vibest/vibestfake"
)

func vibestSession(id, name, project, status, address string, parent *string, created float64) vibest.Session {
	return vibest.Session{ID: id, Name: name, Harness: "pi", ProjectID: project, Status: status, Runtime: "hc", Address: vibest.Address{Machine: "local", ID: address}, ParentID: parent, CreatedAt: created}
}

func applyVibest(a *App, e vibest.Event) {
	a.mu.Lock()
	a.vibestModel.Apply(e)
	a.mu.Unlock()
	a.invalidate()
}

func shippingSnapshot(sessions ...vibest.Session) vibest.Event {
	dir, main := "/code/Shipping", "main"
	return vibest.Event{Tag: "Snapshot", Projects: []vibest.Project{{ID: "p1", Directory: &dir, EntrySessionID: &main}}, Sessions: sessions}
}

func TestProjectSidebarShowsTheMainAgentWithItsSubagentsNested(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	main := "main"
	herdr := vibestSession("h", "in-herdr", "p1", "idle", "ws1:p3", nil, 3)
	herdr.Runtime = "herdr"
	applyVibest(a, shippingSnapshot(
		vibestSession("main", "lead", "p1", "working", "a", nil, 1),
		vibestSession("sub", "reviewer", "p1", "blocked", "b", &main, 2),
		herdr,
	))
	tt.Frame()
	for _, s := range []string{"Projects", "Shipping", "1 waiting", "1 working", "lead", "reviewer", "Waiting for you", "in-herdr"} {
		if !tt.HasText(s) {
			t.Fatalf("%q not shown in %v", s, tt.Texts())
		}
	}
	lead, reviewer, other := find(t, tt, "lead"), find(t, tt, "reviewer"), find(t, tt, "in-herdr")
	if !(lead.Y < reviewer.Y && reviewer.Y < other.Y) || reviewer.X <= lead.X || other.X != lead.X {
		t.Fatalf("lead %v reviewer %v in-herdr %v", lead, reviewer, other)
	}
	if err := tt.Click("reviewer"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.coreSelection.Pane != "b" {
		t.Fatalf("click selected pane %q, want b", a.coreSelection.Pane)
	}
	if err := tt.Click("in-herdr"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.coreSelection.Pane != "b" || a.navigationNote != "in-herdr runs in herdr; only herdr-core terminals open here" {
		t.Fatalf("pane %q note %q", a.coreSelection.Pane, a.navigationNote)
	}
	applyVibest(a, vibest.Event{Tag: "SessionEnded", ID: "sub", ProjectID: "p1"})
	tt.Frame()
	if tt.HasText("reviewer") || tt.HasText("1 waiting") {
		t.Fatalf("ended session still shown: %v", tt.Texts())
	}
	if len(f.otherDocs) != 0 {
		t.Fatalf("documents written besides the layout: %v", f.otherDocs)
	}
}

func TestProjectOwnsWorkspaceAndOpensItsSessionsAndTerminals(t *testing.T) {
	a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		f.layout.Workspaces[1].Project = "p1"
		name := "vbt-echo"
		f.terminals["e"] = core.Terminal{Address: "e", Name: &name, State: "live", Cols: 80, Rows: 24}
	})
	applyVibest(a, shippingSnapshot(vibestSession("main", "echo", "p1", "idle", "vbt-echo", nil, 1)))
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
	if a.paneShowing("e") == "" {
		t.Fatal("the session's terminal is not in a pane")
	}
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
	if got.CWD != "/code/Shipping" || !got.Keep || got.Labels["vibest.project"] != "p1" {
		t.Fatalf("run params %s", runs[0])
	}
}

func TestNewProjectOpensTheFolderInVibest(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	recorded := vibestfake.Load(t, "project-open.ndjson")
	server := vibestfake.Serve(t, recorded[:2], recorded[4:6])
	a.mu.Lock()
	a.vibestSocket = server.Path
	a.mu.Unlock()
	var pick func(string)
	a.folderPicker = func(_ string, run func(string)) bool { pick = run; return true }
	if err := tt.Click("New project"); err != nil {
		t.Fatal(err)
	}
	if pick == nil {
		t.Fatal("the folder chooser was not offered")
	}
	a.mu.Lock()
	pick("/fixture/repo/")
	a.mu.Unlock()
	awaitCoreApp(t, a, func() bool { return len(a.vibestModel.Projects) == 1 })
	tt.Frame()
	if !tt.HasText("repo") {
		t.Fatalf("opened project not shown: %v", tt.Texts())
	}
	if err := tt.Click("New project"); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	pick("/fixture/plain")
	a.mu.Unlock()
	awaitCoreApp(t, a, func() bool { return a.vibestNote != "" })
	tt.Frame()
	if !tt.HasText("Not a git checkout or a folder of git checkouts") {
		t.Fatalf("NotInRepository not shown: %v", tt.Texts())
	}
	if len(f.otherDocs) != 0 {
		t.Fatalf("documents written besides the layout: %v", f.otherDocs)
	}
}
