package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
	"vibest-desktop/internal/core"
)

func TestNavigationExplicitCreationAfterCanceledCapture(t *testing.T) {
	for _, schedule := range []string{"old-reply-held", "old-reply-consumed"} {
		t.Run(schedule, func(t *testing.T) {
			a, f, tt, old, releaseOld := pendingCoreNavigation(t)
			_, other, _ := coreActivityUI(t)
			tt.Type("h")
			tt.KeyUnframed(0, ui.KeyEnter)
			coreAppAct(a, func() {
				a.askInWindow("Cancel capture", "", false, func(string) { t.Error("unexpected modal action") })
			})
			tt.Frame()
			tt.Key(0, ui.KeyEscape)
			if !a.coreBlocked || old.events != nil || old.bytes != 0 {
				t.Fatal("old prefix retained")
			}
			if schedule == "old-reply-consumed" {
				releaseOld()
				awaitCorePaintWithoutOwnership(t, a, tt, "c")
			}
			releaseRun, heldRun := holdCoreMethod(t, f, "terminal.run")
			if err := tt.Click("new-workspace"); err != nil {
				t.Fatal(err)
			}
			tt.TypeKeyNative(0, ui.KeyX, "x")
			tt.KeyUnframed(0, ui.KeyEnter)
			<-heldRun
			noCoreData(t, f)
			noCoreData(t, other)
			n := a.coreCapture
			if n == nil || n.count != 2 {
				t.Fatal("new creation lacks its own sequence")
			}
			releaseOld()
			releaseAttach, heldAttach := holdCoreMethod(t, f, "terminal.attach t5")
			releaseRun()
			awaitCoreApp(t, a, func() bool { return !a.corePending && n.pane != "" })
			tt.Frame()
			<-heldAttach
			noCoreData(t, f)
			if a.coreState.Layout.Pane(n.pane).Terminal.Address != "t5" {
				t.Fatal("creation guessed old identity")
			}
			releaseAttach()
			readyCorePane(t, a, tt, n.pane)
			wantCorePaneInput(t, f, "t5", "x\r")
			tt.Type("y")
			wantCorePaneInput(t, f, "t5", "y")
			noCoreData(t, f)
			noCoreData(t, other)
		})
	}
}

func TestNavigationCanceledCaptureAllowsExplicitRenameButNotTerminalMutation(t *testing.T) {
	a, f, tt, _, release := pendingCoreNavigation(t)
	tt.Type("held")
	coreAppAct(a, func() { a.askInWindow("Cancel capture", "", false, func(string) {}) })
	tt.Frame()
	tt.Key(0, ui.KeyEscape)
	release()
	awaitCorePaintWithoutOwnership(t, a, tt, "c")
	if err := tt.RightClick("terminal/c"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Split right"); err != nil {
		t.Fatal(err)
	}
	if len(coreRequests(f, "terminal.run"))+len(coreRequests(f, "doc.set")) != 0 {
		t.Fatal("blocked terminal mutation dispatched")
	}
	if err := tt.RightClick("terminal/c"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Rename pane"); err != nil {
		t.Fatal(err)
	}
	tt.TypeKeyNative(0, ui.KeyN, "name")
	tt.Frame()
	if !tt.Focused("Rename pane") {
		t.Fatal("rename lost owner")
	}
	tt.Key(0, ui.KeyEnter)
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("c").Label == "name" })
	readyCorePane(t, a, tt, "c")
	tt.TypeKeyNative(0, ui.KeyX, "x")
	wantCorePaneInput(t, f, "c", "x")
	noCoreData(t, f)
}

func TestNavigationCreationBadResultCannotReleaseOldPane(t *testing.T) {
	for _, failure := range []string{"missing-target", "existing-target", "request-error", "closed-parent", "CAS-conflict"} {
		t.Run(failure, func(t *testing.T) {
			a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
				if failure == "missing-target" {
					f.runResult = &core.Terminal{}
				}
				if failure == "existing-target" {
					r := f.terminals["a"]
					f.runResult = &r
				}
			})
			release, held := holdCoreMethod(t, f, "terminal.run")
			navigationRelease(t, tt, "New tab")
			if !tt.CommitTextNative("x") {
				t.Fatal("first creation commit ineligible")
			}
			<-held
			n := a.coreCapture
			if failure == "request-error" || failure == "CAS-conflict" {
				method := "terminal.run"
				if failure == "CAS-conflict" {
					method = "doc.set"
				}
				f.mu.Lock()
				f.failOnce = map[string]string{method: "conflict"}
				f.mu.Unlock()
			}
			if failure == "closed-parent" {
				coreAppAct(a, func() { a.coreEdit(func(l *core.Layout) error { l.Workspaces = l.Workspaces[1:]; return nil }) })
				awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Tab("t1") == nil })
			}
			release()
			awaitCoreApp(t, a, func() bool { return a.coreOperationNote != "" })
			tt.Frame()
			tt.Key(0, ui.KeyEnter)
			noCoreData(t, f)
			if n == nil || n.events != nil || n.bytes != 0 || !a.coreBlocked {
				t.Fatal("bad creation retained or resumed input")
			}
		})
	}
}

func TestNavigationCreationFirstInputWaitsForItsReturnedTarget(t *testing.T) {
	for _, kind := range []string{"workspace", "tab", "split", "worktree.create", "worktree.open"} {
		t.Run(kind, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			_, other, _ := coreActivityUI(t)
			g := &fakeGit{}
			coreAppAct(a, func() { a.gitExec = g.run })
			release, held := holdCoreMethod(t, f, "terminal.run")
			switch kind {
			case "worktree.create":
				coreAppAct(a, func() { a.CreateWorktree("w1", "branch") })
				tt.Frame()
			case "worktree.open":
				coreAppAct(a, func() { a.OpenWorktree("w1", "/inert/repo-branch") })
				tt.Frame()
			case "split":
				tt.Key(ui.Cmd, ui.KeyD)
			default:
				row := "new-workspace"
				if kind == "tab" {
					row = "New tab"
				}
				navigationRelease(t, tt, row)
			}
			if !tt.CommitTextNative("x") {
				t.Fatal("creation FIRST native commit lost")
			}
			<-held
			noCoreData(t, f)
			releaseAttach, attach := holdCoreMethod(t, f, "terminal.attach t5")
			release()
			awaitCoreApp(t, a, func() bool { return !a.corePending && a.coreSelection.Pane != "a" })
			tt.Frame()
			<-attach
			noCoreData(t, f)
			releaseAttach()
			id := a.coreSelection.Pane
			readyCorePane(t, a, tt, id)
			wantCorePaneInput(t, f, "t5", "x")
			tt.TypeKeyNative(0, ui.KeyY, "y")
			wantCorePaneInput(t, f, "t5", "y")
			if a.coreAttached[id].Address != "t5" {
				t.Fatal("creation guessed old target")
			}
			noCoreData(t, other)
			noCoreData(t, f)
		})
	}
}
