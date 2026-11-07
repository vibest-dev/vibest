package app

import (
	"context"
	"github.com/egoist/mygo/ui"
	"testing"
	"vibest-desktop/internal/core"
)

func TestNavigationExistingWorktreeRootIsNotFocusAuthority(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	g := &fakeGit{gate: make(chan struct{}), entered: make(chan struct{})}
	gate := g.gate
	coreAppAct(a, func() { a.gitExec = g.run; a.ShowPane("d") })
	readyCorePane(t, a, tt, "d")
	coreAppAct(a, func() { a.ShowPane("a") })
	readyCorePane(t, a, tt, "a")
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		w := &f.layout.Workspaces[1]
		w.CWD = "/inert/other"
		w.Repository = "/inert/repo/.git"
		w.Tabs = append(w.Tabs, core.Tab{ID: "active-tab", Root: &core.Split{Pane: &core.Pane{ID: "active-pane", Terminal: core.TerminalRef{CoreID: f.layout.CoreID, Address: "c"}}}})
		f.layout.Workspaces[0].Tabs = f.layout.Workspaces[0].Tabs[:1]
	})
	coreAppAct(a, func() { a.ShowPane("active-pane") })
	readyCorePane(t, a, tt, "active-pane")
	coreAppAct(a, func() { a.ShowPane("a"); a.OpenWorktree("w1", "/inert/other") })
	tt.Frame()
	if !tt.CommitTextNative("x") {
		t.Fatal("worktree FIRST commit lost")
	}
	<-g.entered
	noCoreData(t, f)
	close(gate)
	awaitCoreApp(t, a, func() bool { return !a.corePending && a.coreSelection.Pane == "active-pane" })
	readyCorePane(t, a, tt, "active-pane")
	wantCorePaneInput(t, f, "c", "x")
	tt.TypeKeyNative(0, ui.KeyY, "y")
	wantCorePaneInput(t, f, "c", "y")
	if len(coreRequests(f, "terminal.run")) != 0 {
		t.Fatal("existing checkout created a terminal")
	}
	if a.coreState.Layout.Workspaces[1].Branch != "branch" {
		t.Fatal("actual checkout metadata not published")
	}
	noCoreData(t, f)
}
func TestRemoteWorktreeRefusesWithoutLocalGitOrInput(t *testing.T) {
	a, f, tt := coreMachineUI(t)
	called := false
	coreAppAct(a, func() {
		a.gitExec = func(context.Context, *core.Session, string, []string) ([]byte, error) { called = true; return nil, nil }
	})
	terminalWorkspace(t, tt, "Remote Alpha")
	wantRemoteNavigation(t, a, f, tt, "d")
	for _, action := range []string{"create", "open", "remove"} {
		coreAppAct(a, func() {
			switch action {
			case "create":
				a.CreateWorktree("w2", "branch")
			case "open":
				a.OpenWorktree("w2", "/remote/path")
			default:
				a.RemoveWorktree("w2")
			}
		})
		tt.Frame()
		tt.CommitTextNative("x")
		if called || len(coreRequests(f, "terminal.run")) != 0 {
			t.Fatal("remote Git fell back to local filesystem/program")
		}
		noCoreData(t, f)
	}
}
