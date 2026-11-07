package app

import (
	"encoding/json"
	"testing"

	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/vibest"
)

func TestProjectActivityIsTheWatchField(t *testing.T) {
	a := newChromeTestApp()
	for _, activity := range []string{"blocked", "done", "working", "idle"} {
		g := vibest.Group{Project: vibest.Project{Activity: activity}, Rows: []vibest.Row{
			{Session: vibestSession("s", "s", "p1", "blocked", "a", nil, 0)},
		}}
		if got := a.projectStatus(g); got != activity {
			t.Fatalf("activity %s showed %s", activity, got)
		}
	}
	if got := a.projectStatus(vibest.Group{Rows: []vibest.Row{{Session: vibestSession("s", "s", "p1", "blocked", "a", nil, 0)}}}); got != "idle" {
		t.Fatalf("missing activity showed %s", got)
	}
}

func TestEmptyProjectCannotSendToPreviousPaneAndNewTabBelongsToProject(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	applyVibest(a, shippingSnapshot())
	tt.Frame()
	openShipping(t, a, tt)
	absent(t, tt, "terminal/a", "tab/t1", "tab/t2")
	if tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("empty project retained previous native input owner")
	}
	tt.Type("not for old pane")
	noCoreData(t, f)
	tt.Key(ui.Cmd, ui.KeyT)
	if !tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("project creation lost first input")
	}
	var id string
	awaitCoreApp(t, a, func() bool {
		id = a.coreSelection.Pane
		return !a.corePending && id != "a" && a.coreState.Programs["t5"] != 0
	})
	readyCorePane(t, a, tt, id)
	wantCorePaneInput(t, f, "t5", "x")
	var run core.TerminalRunParams
	json.Unmarshal(coreRequests(f, "terminal.run")[0], &run)
	if run.CWD == nil || *run.CWD != "/code/Shipping" || run.Labels[ProjectLabel] != "p1" {
		t.Fatalf("wrong project terminal: %+v", run)
	}
}

func TestProjectShortcutsFollowVisibleSessionOrderNotStoredCoreTabs(t *testing.T) {
	a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		f.layout.Workspaces[0].Project = "p1"
		r := f.terminals["b"]
		r.Labels = map[string]string{pinnedLabel: "1"}
		f.terminals["b"] = r
	})
	main := "main"
	applyVibest(a, shippingSnapshot(
		vibestSession("main", "lead", "p1", "idle", "a", nil, 1),
		vibestSession("first", "first", "p1", "idle", "c", &main, 2),
		vibestSession("pinned", "pinned", "p1", "idle", "b", &main, 3),
	))
	tt.Frame()
	if find(t, tt, "pinned").X >= find(t, tt, "first").X {
		t.Fatal("pin order is not visible")
	}
	for _, step := range []struct {
		mods ui.Modifiers
		key  ui.Key
		id   string
	}{
		{ui.Cmd, ui.Key2, "b"}, {ui.Cmd | ui.Shift, ui.KeyBracketRight, "c"},
		{ui.Cmd, ui.Key1, "a"}, {ui.Cmd | ui.Shift, ui.KeyBracketLeft, "c"},
	} {
		tt.Key(step.mods, step.key)
		readyCorePane(t, a, tt, step.id)
		tt.Type("x")
		wantCorePaneInput(t, f, step.id, "x")
	}
	if len(coreRequests(f, "doc.set")) != 0 {
		t.Fatal("tab navigation rewrote existing layout")
	}
}

func TestProjectAdoptsHerdrLabelsWithoutWatchSession(t *testing.T) {
	a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		f.terminals["e"] = core.Terminal{Address: "e", State: "live", Cols: 80, Rows: 24, Labels: map[string]string{"herdr.space": "p1", "herdr.tab": "shell"}}
	})
	applyVibest(a, shippingSnapshot())
	tt.Frame()
	openShipping(t, a, tt)
	var id string
	coreAppAct(a, func() { id = a.coreSelection.Pane })
	readyCorePane(t, a, tt, id)
	find(t, tt, "session: shell")
	tt.Type("x")
	wantCorePaneInput(t, f, "e", "x")
	coreAppAct(a, func() {
		if a.coreState.Layout.Pane(id).Terminal.Address != "e" {
			t.Fatal("label group selected another terminal")
		}
		if err := a.coreState.Layout.Validate(a.coreState.Layout.CoreID); err != nil {
			t.Fatal(err)
		}
	})
}

func TestUnprojectedTerminalMenuAdoptsExistingProgramWithFirstInput(t *testing.T) {
	a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		f.terminals["e"] = core.Terminal{Address: "e", State: "live", Cols: 80, Rows: 24, Labels: map[string]string{ProjectLabel: "unknown-project"}}
	})
	release, held := holdCoreMethod(t, f, "doc.set")
	if err := tt.Click("Terminals"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Open e"); err != nil {
		t.Fatal(err)
	}
	if !tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("adoption lost first native input")
	}
	<-held
	noCoreData(t, f)
	release()
	finishProjectOpen(t, a, tt)
	var id string
	awaitCoreApp(t, a, func() bool {
		id = a.coreSelection.Pane
		return !a.corePending && id != "a"
	})
	readyCorePane(t, a, tt, id)
	wantCorePaneInput(t, f, "e", "x")
	if len(coreRequests(f, "terminal.run")) != 0 {
		t.Fatal("opening an existing terminal spawned another program")
	}
}

func TestProjectRemoteAdoptionNeverClaimsNativeInput(t *testing.T) {
	a, f, tt := coreMachineUI(t)
	s := vibestSession("main", "remote", "p1", "working", "r", nil, 1)
	s.Address.Machine = "Remote"
	applyVibest(a, shippingSnapshot(s))
	tt.Frame()
	release, held := holdCoreMethod(t, f, "doc.set")
	if err := tt.Click("project: Shipping"); err != nil {
		t.Fatal(err)
	}
	if tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("remote adoption claimed native input")
	}
	<-held
	noCoreData(t, f)
	release()
	finishProjectOpen(t, a, tt)
	awaitCoreApp(t, a, func() bool { return !a.corePending && a.coreSelection.Pane == "d" })
	wantRemoteNavigation(t, a, f, tt, "d")
}

func TestProjectWatchUpdatesKeepTheSelectedTerminalInputOwner(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	main := "main"
	applyVibest(a, shippingSnapshot(vibestSession(main, "lead", "p1", "working", "a", nil, 1)))
	tt.Frame()
	openShipping(t, a, tt)
	readyCorePane(t, a, tt, "a")
	for _, id := range []string{"b", "c"} {
		s := vibestSession(id, id, "p1", "working", id, &main, 2)
		applyVibest(a, vibest.Event{Tag: "Session", Session: &s})
		tt.Frame()
		find(t, tt, "session: "+id)
		if !tt.TypeKeyNative(0, ui.KeyX, "x") {
			t.Fatal("new agent tab stole native eligibility")
		}
		tt.Key(0, ui.KeyEnter)
		wantCorePaneInput(t, f, "a", "x")
		wantCorePaneInput(t, f, "a", "\r")
	}
	noCoreData(t, f)
}

func TestTerminalsMenuDistinguishesUnnamedWorkspaces(t *testing.T) {
	a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		for i := range f.layout.Workspaces {
			f.layout.Workspaces[i].Label = ""
		}
	})
	terminalWorkspace(t, tt, "2")
	readyCorePane(t, a, tt, "d")
	tt.Type("x")
	wantCorePaneInput(t, f, "d", "x")
}

func TestSupersededProjectAdoptionCannotReplayIntoAnotherSelection(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	applyVibest(a, shippingSnapshot(vibestSession("main", "lead", "p1", "working", "b", nil, 1)))
	tt.Frame()
	release, held := holdCoreMethod(t, f, "doc.set")
	if err := tt.Click("project: Shipping"); err != nil {
		t.Fatal(err)
	}
	tt.Type("discard")
	<-held
	terminalWorkspace(t, tt, "Other")
	readyCorePane(t, a, tt, "d")
	tt.Type("keep")
	wantCorePaneInput(t, f, "d", "keep")
	release()
	awaitCoreApp(t, a, func() bool {
		_, project := paneForRef(&a.coreState.Layout, core.TerminalRef{CoreID: a.coreState.Layout.CoreID, Address: "b"})
		return project == "p1"
	})
	tt.Frame()
	coreAppAct(a, func() {
		if a.coreSelection.Pane != "d" {
			t.Fatal("late adoption retargeted selection")
		}
	})
	noCoreData(t, f)
}
