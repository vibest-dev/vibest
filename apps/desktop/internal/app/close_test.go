package app

import (
	"encoding/json"
	"github.com/egoist/mygo/ui"
	"reflect"
	"slices"
	"strings"
	"testing"
	"vibest-desktop/internal/core"
)

func coreRequests(f *coreAppFixture, method string) []json.RawMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []json.RawMessage
	for i, m := range f.methods {
		if m == method {
			out = append(out, f.params[i])
		}
	}
	return out
}
func noCoreClose(t *testing.T, f *coreAppFixture) {
	t.Helper()
	if len(coreRequests(f, "terminal.kill")) != 0 || len(coreRequests(f, "doc.set")) != 0 {
		t.Fatal("unconfirmed/stale close changed Core")
	}
}
func openCoreClose(t *testing.T, a *App, tt *ui.Tester, id string) *dialog {
	t.Helper()
	coreAppAct(a, func() { a.ClosePane(id) })
	tt.Frame()
	a.mu.Lock()
	d := a.dialog
	a.mu.Unlock()
	if d == nil || !tt.HasText("Close terminal?") {
		t.Fatal("missing conservative confirmation")
	}
	return d
}
func coreKilled(t *testing.T, f *coreAppFixture, want ...string) {
	t.Helper()
	got := []string{}
	for _, raw := range coreRequests(f, "terminal.kill") {
		var p struct{ Terminal string }
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatal(err)
		}
		got = append(got, p.Terminal)
	}
	slices.Sort(got)
	slices.Sort(want)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("killed=%v want %v", got, want)
	}
}
func TestReportedIdleStillRequiresConfirmation(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	reportActivity(t, a, f, "a", "idle", 0, true)
	openCoreClose(t, a, tt, "a")
	noCoreClose(t, f)
	if err := tt.Click("Cancel"); err != nil {
		t.Fatal(err)
	}
	readyCorePane(t, a, tt, "a")
	noCoreClose(t, f)
}
func TestBusyPaneAsksAndCancelCloses(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	reportActivity(t, a, f, "a", "working", 0, true)
	openCoreClose(t, a, tt, "a")
	tt.Key(0, ui.KeyEscape)
	readyCorePane(t, a, tt, "a")
	noCoreClose(t, f)
	if a.State().Closing != "" {
		t.Fatal("cancel left a pending close")
	}
}
func TestEnterOnTheDialogDoesNotClose(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	openCoreClose(t, a, tt, "a")
	if !tt.Focused("Cancel") {
		t.Fatal("close confirmation did not default to Cancel")
	}
	tt.Key(0, ui.KeyEnter)
	readyCorePane(t, a, tt, "a")
	noCoreClose(t, f)
}
func TestConfirmClosesOnlyThatPaneOnce(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	d := openCoreClose(t, a, tt, "b")
	if err := tt.Click("Close"); err != nil {
		t.Fatal(err)
	}
	coreAppAct(a, func() { d.run(""); d.run("") })
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("b") == nil && len(a.coreClosing) == 0 })
	coreKilled(t, f, "b")
	calls := coreRequests(f, "doc.set")
	if len(calls) != 1 {
		t.Fatalf("layout requests=%d", len(calls))
	}
	var set struct {
		Name    string
		Version uint64
		Value   core.Layout
	}
	json.Unmarshal(calls[0], &set)
	if set.Name != core.LayoutDocument || set.Version != 0 || set.Value.Pane("a") == nil || set.Value.Pane("b") != nil {
		t.Fatalf("incorrect CAS removal: %+v", set)
	}
}
func TestUncheckedPaneAsks(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	reportActivity(t, a, f, "a", "", 0, false)
	openCoreClose(t, a, tt, "a")
	noCoreClose(t, f)
	tt.Key(0, ui.KeyEscape)
}
func TestPaneGoneOrRestartedMeanwhileIsNotClosed(t *testing.T) {
	for _, kind := range []string{"removed", "restarted"} {
		t.Run(kind, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			openCoreClose(t, a, tt, "a")
			f.mu.Lock()
			record := f.terminals["a"]
			f.mu.Unlock()
			f.report(kind, record)
			awaitCoreApp(t, a, func() bool { return a.coreState.Programs["a"] == 1 })
			if err := tt.Click("Close"); err != nil {
				t.Fatal(err)
			}
			noCoreClose(t, f)
			if !strings.Contains(a.State().Toast, "Not closed") {
				t.Fatal("stale target not explained")
			}
		})
	}
}
func TestRepeatedCloseKeepsOneConfirmation(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	first := openCoreClose(t, a, tt, "a")
	coreAppAct(a, func() {
		a.ClosePane("a")
		a.ClosePane("b")
		if a.dialog != first {
			t.Fatal("repeated close replaced intent")
		}
	})
	noCoreClose(t, f)
	tt.Key(0, ui.KeyEscape)
	coreAppAct(a, func() { first.run("") })
	noCoreClose(t, f)
}
func TestFocusMovingKeepsTheTarget(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	openCoreClose(t, a, tt, "a")
	coreAppAct(a, func() { a.ShowPane("b") })
	tt.Frame()
	if err := tt.Click("Close"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("a") == nil && len(a.coreClosing) == 0 })
	coreKilled(t, f, "a")
	readyCorePane(t, a, tt, "b")
	tt.Type("survivor")
	wantCoreInput(t, f, "survivor")
}
func TestChangedConnectionDropsTheClose(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	d := openCoreClose(t, a, tt, "a")
	next := reconnectCoreApp(t, a, f, coreActivitySeed)
	coreAppAct(a, func() { a.dialog = nil; d.run("") })
	noCoreClose(t, f)
	noCoreClose(t, next)
	if !strings.Contains(a.State().Toast, "connection changed") {
		t.Fatal("changed session not refused")
	}
}
func TestRemoteCloseUsesPinnedOwnerAcrossAliasChanges(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		coreActivitySeed(f)
		p := f.layout.Pane("d")
		p.Terminal = core.TerminalRef{CoreID: "remote-A", Address: "alias/d"}
		f.layout.Workspaces[1].Machine = "alias"
		f.machines = []core.MachineView{{Name: "renamed", ID: "remote-A", State: "connected"}, {Name: "alias", ID: "remote-B", State: "connected"}}
		f.terminals["alias/d"] = core.Terminal{Address: "alias/d"}
	})
	coreAppAct(a, func() {
		a.ClosePane("d")
		d := a.dialog
		if d == nil {
			t.Fatal("no remote confirmation")
		}
		a.dialog = nil
		d.run("")
	})
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("d") == nil && len(a.coreClosing) == 0 })
	coreKilled(t, f, "remote-A/d")
}
func TestReplacedPinnedTargetDropsTheClose(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	openCoreClose(t, a, tt, "a")
	coreAppAct(a, func() {
		a.coreEdit(func(l *core.Layout) error {
			l.Pane("a").Terminal = core.TerminalRef{CoreID: "app-fixture", Address: "replacement"}
			return nil
		})
	})
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("a").Terminal.Address == "replacement" })
	before := len(coreRequests(f, "doc.set"))
	if err := tt.Click("Close"); err != nil {
		t.Fatal(err)
	}
	if len(coreRequests(f, "terminal.kill")) != 0 || len(coreRequests(f, "doc.set")) != before {
		t.Fatal("close followed replaced reference")
	}
}
func TestNoConnectionClosesNothing(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	f.peer.Close()
	awaitCoreApp(t, a, func() bool { return !a.connected })
	coreAppAct(a, func() { a.ClosePane("a") })
	tt.Frame()
	noCoreClose(t, f)
	if a.State().Closing != "" {
		t.Fatal("offline close stayed pending")
	}
}
func TestEveryPaneCloseRequiresConfirmation(t *testing.T) {
	for _, how := range []string{"chord", "button", "menu"} {
		t.Run(how, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			switch how {
			case "chord":
				tt.Key(ui.Cmd, ui.KeyW)
			case "button":
				if err := tt.Click("close-pane/a"); err != nil {
					t.Fatal(err)
				}
			case "menu":
				r := find(t, tt, "pane/a")
				tt.RightClickAt(r.X+20, r.Y+10)
				if err := tt.ChooseMenuItem("Close pane"); err != nil {
					t.Fatal(err)
				}
			}
			tt.Frame()
			if !tt.HasText("Close terminal?") {
				t.Fatal("close route bypassed confirmation")
			}
			noCoreClose(t, f)
			tt.Key(0, ui.KeyEscape)
			readyCorePane(t, a, tt, "a")
		})
	}
}
func TestReplacedDialogReleasesTheClose(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	d := openCoreClose(t, a, tt, "a")
	coreAppAct(a, func() { a.askInWindow("Replacement", "", false, func(string) {}); d.run("") })
	tt.Frame()
	tt.Type("dialog only")
	if !tt.Focused("Replacement") || a.State().Closing != "" {
		t.Fatal("old close disturbed replacement modal")
	}
	noCoreClose(t, f)
	select {
	case p := <-f.inputs:
		t.Fatalf("dialog leaked %q", p.body)
	default:
	}
}
func TestCloseRefusalAndCASFailureDoNotReplay(t *testing.T) {
	for _, method := range []string{"terminal.kill", "doc.set"} {
		t.Run(method, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			f.mu.Lock()
			kind := "unavailable"
			if method == "doc.set" {
				kind = "conflict"
			}
			f.failOnce = map[string]string{method: kind}
			f.mu.Unlock()
			openCoreClose(t, a, tt, "a")
			if err := tt.Click("Close"); err != nil {
				t.Fatal(err)
			}
			awaitCoreApp(t, a, func() bool {
				return len(a.coreClosing) == 0 && strings.Contains(a.navigationNote, "Close") || len(a.coreClosing) == 0 && strings.Contains(a.navigationNote, "layout removal failed")
			})
			if len(coreRequests(f, "terminal.kill")) != 1 || a.coreState.Layout.Pane("a") == nil {
				t.Fatal("refusal replayed kill or removed uncommitted layout")
			}
			if method == "doc.set" && len(coreRequests(f, "doc.set")) != 1 {
				t.Fatal("conflict replayed mutation")
			}
		})
	}
}
func TestStateShowsTheClose(t *testing.T) {
	a, _, tt := coreActivityUI(t)
	openCoreClose(t, a, tt, "a")
	if s := a.State(); s.Closing != "a" || !strings.Contains(s.Dialog, "Close terminal?") {
		t.Fatalf("close state: %+v", s)
	}
}

func TestRepositoryGroupCloseUsesOneConfirmedCAS(t *testing.T) {
	a, f, tt := repositoryCoreUI(t)
	coreAppAct(a, func() { a.CloseWorkspaceGroup("w1") })
	tt.Frame()
	noCoreClose(t, f)
	if err := tt.Click("Close"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces) == 0 && len(a.coreClosing) == 0 })
	coreKilled(t, f, "a", "b", "c", "d")
	if len(coreRequests(f, "doc.set")) != 1 {
		t.Fatal("group close did not use one layout CAS")
	}
}
