package app

import (
	"github.com/egoist/mygo/ui"
	"os"
	"slices"
	"testing"
	"vibest-desktop/internal/core"
)

func tabFixture(t *testing.T, ids ...string) (*App, *coreAppFixture, func(func(*core.Layout)), *ui.Tester) {
	t.Helper()
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified software VT required")
	}
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		w := core.Workspace{ID: "w1", Label: "Tabs"}
		for _, id := range ids {
			address := "p-" + id
			f.terminals[address] = core.Terminal{Address: address, State: "live", Reported: true, Turn: 1, Cols: 80, Rows: 24}
			w.Tabs = append(w.Tabs, core.Tab{ID: id, Label: id, Root: &core.Split{Pane: &core.Pane{ID: address, Terminal: core.TerminalRef{CoreID: f.layout.CoreID, Address: address}}}})
		}
		f.layout.Workspaces = []core.Workspace{w}
	})
	tt := ui.NewTester(a.View, 1280, 800)
	readyCorePane(t, a, tt, "p-"+ids[0])
	return a, f, func(change func(*core.Layout)) {
		publishCoreLayout(t, a, f, func(f *coreAppFixture) { change(&f.layout) })
	}, tt
}
func tabOrder(a *App) []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for _, t := range a.coreState.Layout.Workspaces[0].Tabs {
		out = append(out, t.ID)
	}
	return out
}
func wantTabOrder(t *testing.T, a *App, tt *ui.Tester, ids ...string) {
	t.Helper()
	awaitCoreApp(t, a, func() bool { return slices.Equal(tabOrderUnlocked(a), ids) && !a.corePending })
	tt.Frame()
}
func tabOrderUnlocked(a *App) []string {
	var out []string
	for _, t := range a.coreState.Layout.Workspaces[0].Tabs {
		out = append(out, t.ID)
	}
	return out
}
func TestTabMoveRightMenuSlotRegression(t *testing.T) {
	a, f, _, tt := tabFixture(t, "t1", "t2", "t3")
	for _, step := range []struct {
		id, action string
		order      []string
	}{{"t1", "Move right", []string{"t2", "t1", "t3"}}, {"t1", "Move right", []string{"t2", "t3", "t1"}}, {"t3", "Move left", []string{"t3", "t2", "t1"}}} {
		if err := tt.RightClick("tab/" + step.id); err != nil {
			t.Fatal(err)
		}
		if err := tt.ChooseMenuItem(step.action); err != nil {
			t.Fatal(err)
		}
		wantTabOrder(t, a, tt, step.order...)
	}
	noCoreData(t, f)
	noLegacyNavigation(t, f)
}
func TestTabDragReorderGestureParametersAndNoOp(t *testing.T) {
	a, f, _, tt := tabFixture(t, "t1", "t2", "t3", "t4")
	tabGesture(t, tt, "t1", "tab/t2")
	wantTabOrder(t, a, tt, "t2", "t1", "t3", "t4")
	tabGesture(t, tt, "t4", "tab/t1")
	wantTabOrder(t, a, tt, "t2", "t4", "t1", "t3")
	tabGesture(t, tt, "t1", "New tab")
	wantTabOrder(t, a, tt, "t2", "t4", "t3", "t1")
	tabGesture(t, tt, "t2", "tab/t2")
	tabGesture(t, tt, "t1", "New tab")
	if len(coreRequests(f, "doc.set")) != 3 || a.coreSelection.Tab != "t1" {
		t.Fatal("no-op dispatched or drag navigated")
	}
	noCoreData(t, f)
}
func TestTabDragThresholdVersusClick(t *testing.T) {
	a, f, _, tt := tabFixture(t, "t1", "t2", "t3")
	b := find(t, tt, "tab/t2")
	tt.Press(b.X+20, b.Y+14)
	tt.Move(b.X+21, b.Y+14)
	tt.Release(b.X+21, b.Y+14)
	if a.coreSelection.Tab != "t2" {
		t.Fatal("subthreshold click not selected")
	}
	readyCorePane(t, a, tt, "p-t2")
	tabGesture(t, tt, "t2", "tab/t3")
	wantTabOrder(t, a, tt, "t1", "t3", "t2")
	if a.coreSelection.Tab != "t2" {
		t.Fatal("drag selected destination")
	}
	noCoreData(t, f)
}
func TestTabDragCancellationEscapeAndOutside(t *testing.T) {
	for _, finish := range []string{"escape", "outside"} {
		a, f, _, tt := tabDragFixture(t, paneComfortable)
		finishTabGesture(t, tt, finish, "t1")
		tabDragOnly(t, a, f, 0)
		noCoreData(t, f)
	}
}
func TestTabCloseControlDuringHover(t *testing.T) {
	a, f, _, tt := tabFixture(t, "t1", "t2", "t3")
	b := find(t, tt, "tab/t1")
	tt.Move(b.X+b.W-15, b.Y+14)
	r := find(t, tt, "close/t1")
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	if a.dialog == nil || len(coreRequests(f, "terminal.kill")) != 0 {
		t.Fatal("close control failed/bypassed confirmation")
	}
	if err := tt.Click("Close"); err != nil {
		t.Fatal(err)
	}
	wantTabOrder(t, a, tt, "t2", "t3")
	noCoreData(t, f)
}
func TestTabDragAuthoritativeWireSnapshotUpdatesKeyboardOrder(t *testing.T) {
	a, f, update, tt := tabFixture(t, "t1", "t2", "t3")
	tabGesture(t, tt, "t1", "tab/t3")
	wantTabOrder(t, a, tt, "t2", "t3", "t1")
	update(func(l *core.Layout) { slices.Reverse(l.Workspaces[0].Tabs) })
	tt.Frame()
	tt.Key(ui.Cmd, ui.Key1)
	if a.coreSelection.Tab != "t1" {
		t.Fatal("shortcut ignored actual document order")
	}
	tt.Key(ui.Cmd, ui.Key3)
	if a.coreSelection.Tab != "t2" {
		t.Fatal("third shortcut wrong")
	}
	noCoreData(t, f)
}
func TestTabDragStaleCrossEndpointAndCollisionProtection(t *testing.T) {
	a, f, _, tt := tabFixture(t, "t1", "t2")
	startTabGesture(t, a, tt, true)
	d := *a.activeTabDrag
	if !a.validTabDrag(&d) {
		t.Fatal("valid control rejected")
	}
	for _, change := range []func(*tabDrag){func(d *tabDrag) { d.workspaceID = "other" }, func(d *tabDrag) { d.machineID = "remote" }, func(d *tabDrag) { d.coreSession = nil }, func(d *tabDrag) { d.identities = nil }} {
		bad := d
		change(&bad)
		if a.validTabDrag(&bad) {
			t.Fatal("stale source accepted")
		}
	}
	tt.Release(500, 500)
	noCoreData(t, f)
}
