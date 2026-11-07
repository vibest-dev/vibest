package app

import (
	"github.com/egoist/mygo/ui"
	"strings"
	"testing"
	"vibest-desktop/internal/core"
)

func TestWorktreeGitFailureAndNewerIntentKeepOriginalInputFenced(t *testing.T) {
	for _, action := range []string{"failure", "newer intent", "source replaced"} {
		t.Run(action, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			g := &fakeGit{gate: make(chan struct{}), entered: make(chan struct{})}
			gate := g.gate
			coreAppAct(a, func() { a.gitExec = g.run; a.CreateWorktree("w1", "branch") })
			tt.Frame()
			tt.CommitTextNative("first")
			<-g.entered
			switch action {
			case "failure":
				g.mu.Lock()
				g.fail = "worktree add"
				g.mu.Unlock()
			case "newer intent":
				coreAppAct(a, func() { a.ShowPane("d") })
				readyCorePane(t, a, tt, "d")
			case "source replaced":
				publishCoreLayout(t, a, f, func(f *coreAppFixture) {
					f.layout.Workspaces[0].Tabs[0].Root.Pane = &core.Pane{ID: "replacement", Terminal: core.TerminalRef{CoreID: f.layout.CoreID, Address: "b"}}
					f.layout.Workspaces[0].Tabs[0].Root.First = nil
					f.layout.Workspaces[0].Tabs[0].Root.Second = nil
					f.layout.Workspaces[0].Tabs[0].Root.Axis = ""
					f.layout.Workspaces[0].Tabs[0].Root.Ratio = 0
				})
			}
			close(gate)
			awaitCoreApp(t, a, func() bool { return a.coreOperationNote != "" || action == "newer intent" && a.coreCapture == nil })
			if len(coreRequests(f, "terminal.run")) != 0 {
				t.Fatal("stale/failed Git created program")
			}
			if action == "newer intent" {
				tt.Type("new")
				wantCorePaneInput(t, f, "d", "new")
			} else {
				if a.navigationNote != navigationLost {
					t.Fatal("unsent explanation lost", a.navigationNote)
				}
				coreAppAct(a, func() { a.ShowPane("d") })
				readyCorePane(t, a, tt, "d")
				tt.Type("new")
				wantCorePaneInput(t, f, "d", "new")
			}
			noCoreData(t, f)
		})
	}
}
func TestWorktreeRemovalIsConfirmedNonForcedAndKeepsDirtyCheckout(t *testing.T) {
	for _, outcome := range []string{"cancel", "dirty", "remove", "identity changed"} {
		t.Run(outcome, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			g := &fakeGit{}
			publishCoreLayout(t, a, f, func(f *coreAppFixture) {
				w := &f.layout.Workspaces[1]
				w.CWD = "/inert/other"
				w.Repository = "/inert/repo/.git"
				w.Linked = true
			})
			coreAppAct(a, func() { a.gitExec = g.run; a.RemoveWorktree("w2") })
			tt.Frame()
			if a.dialog == nil {
				t.Fatal("removal omitted confirmation")
			}
			g.mu.Lock()
			if len(g.calls) != 0 {
				t.Fatal("Git before confirmation")
			}
			if outcome == "dirty" {
				g.fail = "worktree remove"
			}
			g.mu.Unlock()
			if outcome == "identity changed" {
				publishCoreLayout(t, a, f, func(f *coreAppFixture) { f.layout.Workspaces[1].CWD = "/inert/changed" })
			}
			if outcome == "cancel" {
				tt.Key(0, ui.KeyEscape)
			} else {
				if err := tt.Click("Close"); err != nil {
					t.Fatal(err)
				}
				awaitCoreApp(t, a, func() bool { return a.navigationNote != "" })
			}
			g.mu.Lock()
			defer g.mu.Unlock()
			removed := 0
			for _, c := range g.calls {
				if len(c.args) > 1 && c.args[0] == "worktree" && c.args[1] == "remove" {
					removed++
					if c.cwd != "/inert/repo" || strings.Join(c.args, "|") != "worktree|remove|--|/inert/other" {
						t.Fatal("forced/wrong removal", c)
					}
				}
			}
			if outcome == "cancel" || outcome == "identity changed" {
				if removed != 0 {
					t.Fatal("canceled/stale removal ran")
				}
			} else if removed != 1 {
				t.Fatal("removal count", removed)
			}
			if len(coreRequests(f, "terminal.kill")) != 0 {
				t.Fatal("checkout removal killed terminal")
			}
			w := a.coreState.Layout.Workspaces[1]
			if outcome == "dirty" && !w.Linked {
				t.Fatal("dirty refusal lost metadata")
			}
			if outcome == "remove" && w.Linked {
				t.Fatal("removed checkout remained linked")
			}
			noCoreData(t, f)
		})
	}
}
func TestEditorTerminalFacilityUsesReturnedCoreTarget(t *testing.T) {
	t.Setenv("VISUAL", "")
	t.Setenv("EDITOR", "nvim")
	t.Setenv("TMPDIR", t.TempDir())
	a, f, tt := coreActivityUI(t)
	coreAppAct(a, func() { a.EditScrollback("a") })
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces[0].Tabs) == 3 })
	var pane string
	coreAppAct(a, func() { pane = a.coreState.Layout.Workspaces[0].Tabs[2].Root.Pane.ID })
	readyCorePane(t, a, tt, pane)
	requests := coreRequests(f, "terminal.run")
	if len(requests) != 1 || !strings.Contains(string(requests[0]), "nvim") {
		t.Fatal("editor was injected into original terminal", requests)
	}
	tt.Type("i")
	wantCorePaneInput(t, f, "t5", "i")
	noCoreData(t, f)
}

func TestWorktreeCreatedCheckoutRemainsNamedWhenCoreRunFails(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	g := &fakeGit{gate: make(chan struct{}), entered: make(chan struct{})}
	gate := g.gate
	f.mu.Lock()
	f.failOnce = map[string]string{"terminal.run": "refused"}
	f.mu.Unlock()
	coreAppAct(a, func() { a.gitExec = g.run; a.CreateWorktree("w1", "branch") })
	tt.Frame()
	tt.CommitTextNative("first")
	<-g.entered
	close(gate)
	awaitCoreApp(t, a, func() bool {
		return a.coreBlocked && a.coreCapture == nil && strings.Contains(a.coreOperationNote, "/inert/repo-branch")
	})
	coreAppAct(a, func() {
		if !a.coreBlocked || a.navigationNote != navigationLost {
			t.Fatal("creation failure hid lost input", a.navigationNote, a.coreOperationNote)
		}
	})
	if len(coreRequests(f, "terminal.run")) != 1 || len(coreRequests(f, "terminal.kill"))+len(coreRequests(f, "doc.set")) != 0 {
		t.Fatal("failed create retried, cleaned up or changed topology")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	adds := 0
	for _, c := range g.calls {
		if len(c.args) > 1 && c.args[0] == "worktree" && c.args[1] == "add" {
			adds++
		}
	}
	if adds != 1 {
		t.Fatal("Git creation retried", adds)
	}
	noCoreData(t, f)
}
