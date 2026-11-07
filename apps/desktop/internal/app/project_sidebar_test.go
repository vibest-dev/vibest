package app

import (
	"encoding/json"
	"github.com/egoist/mygo/ui"
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

func finishProjectOpen(t *testing.T, a *App, tt *ui.Tester) {
	t.Helper()
	awaitCoreApp(t, a, func() bool { return a.projectOpened != nil || !a.corePending })
	coreAppAct(a, func() {
		if a.projectOpened != nil && a.coreSelected != nil {
			t.Fatal("project adoption selected a terminal before its UI frame")
		}
	})
	tt.Frame()
}

func openShipping(t *testing.T, a *App, tt *ui.Tester) {
	t.Helper()
	if err := tt.Click("project: Shipping"); err != nil {
		t.Fatal(err)
	}
	finishProjectOpen(t, a, tt)
	awaitCoreApp(t, a, func() bool { return a.currentProject() == "p1" && !a.corePending })
	tt.Frame()
}

func TestProjectSidebarIsFlatAndAgentsAreTabs(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	main := "main"
	other := vibestSession("h", "in-herdr", "p1", "idle", "ws1:p3", nil, 3)
	other.Runtime = "herdr"
	snap := shippingSnapshot(
		vibestSession("main", "lead", "p1", "working", "a", nil, 1),
		vibestSession("sub", "reviewer", "p1", "blocked", "b", &main, 2), other,
	)
	snap.Projects[0].Activity = "blocked"
	applyVibest(a, snap)
	tt.Frame()
	find(t, tt, "project: Shipping")
	find(t, tt, "Terminals")
	absent(t, tt, "Collapse project: Shipping", "Expand project: Shipping", "machine: Local", "Repo", "Other", "lead", "reviewer")
	if activityDescriptions(tt)["Waiting for you"] != 1 {
		t.Fatal("project does not show one aggregate status")
	}
	release, held := holdCoreMethod(t, f, "doc.set")
	if err := tt.Click("project: Shipping"); err != nil {
		t.Fatal(err)
	}
	if !tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("project switch lost first input")
	}
	<-held
	noCoreData(t, f)
	release()
	finishProjectOpen(t, a, tt)
	awaitCoreApp(t, a, func() bool { return a.currentProject() == "p1" && !a.corePending })
	readyCorePane(t, a, tt, "a")
	wantCorePaneInput(t, f, "a", "x")
	lead, reviewer, bar := find(t, tt, "lead"), find(t, tt, "reviewer"), find(t, tt, "tab-bar")
	if lead.Y != reviewer.Y || lead.Y < bar.Y || lead.Y >= bar.Y+bar.H || reviewer.X <= lead.X {
		t.Fatal("agents are not flat content tabs")
	}
	if err := tt.Click("reviewer"); err != nil {
		t.Fatal(err)
	}
	readyCorePane(t, a, tt, "b")
	tt.Type("y")
	wantCorePaneInput(t, f, "b", "y")
	if err := tt.Click("in-herdr"); err != nil {
		t.Fatal(err)
	}
	coreAppAct(a, func() {
		if a.coreSelection.Pane != "b" || a.navigationNote == "" {
			t.Fatal("foreign session retargeted input")
		}
	})
	if tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("unavailable agent kept the previous native owner")
	}
	tt.Type("not for previous agent")
	noCoreData(t, f)
	applyVibest(a, vibest.Event{Tag: "SessionEnded", ID: "sub", ProjectID: "p1"})
	tt.Frame()
	absent(t, tt, "reviewer")
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.otherDocs) != 0 {
		t.Fatal("wrote another client's document")
	}
}

func TestProjectOwnsWorkspaceAndOpensItsSessionsAndTerminals(t *testing.T) {
	a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		f.layout.Workspaces[1].Project = "p1"
		f.terminals["e"] = core.Terminal{Address: "e", State: "live", Cols: 80, Rows: 24}
	})
	applyVibest(a, shippingSnapshot(vibestSession("main", "echo", "p1", "idle", "e@/inert/never-dialed.sock", nil, 1)))
	tt.Frame()
	tabs := func() int {
		for _, w := range a.coreState.Layout.Workspaces {
			if w.ID == "w2" {
				return len(w.Tabs)
			}
		}
		return 0
	}
	find(t, tt, "Terminals")
	if tt.HasText("Other") {
		t.Fatalf("Project workspace still listed as a plain workspace: %v", tt.Texts())
	}
	openShipping(t, a, tt)
	coreAppAct(a, func() {
		if a.coreSelection.Workspace != "w2" {
			t.Fatalf("selecting the Project showed %q, want w2", a.coreSelection.Workspace)
		}
	})
	if err := tt.Click("echo"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return tabs() == 2 })
	coreAppAct(a, func() {
		if a.paneShowing("e") == "" {
			t.Fatal("the session's terminal is not in a pane")
		}
	})
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
