package app

import (
	"encoding/json"
	"fmt"
	"github.com/egoist/mygo/ui"
	"slices"
	"testing"
	"time"
	"vibest-desktop/internal/core"
)

func tabDragFixture(t *testing.T, style string) (*App, *coreAppFixture, func(func(*core.Layout)), *ui.Tester) {
	a, f, update, tt := tabFixture(t, "t1", "t2", "t3", "t4")
	useStyle(t, a, style)
	tt.Frame()
	tt.Advance(time.Second)
	readyCorePane(t, a, tt, "p-t1")
	return a, f, update, tt
}
func tabDragOnly(t *testing.T, a *App, f *coreAppFixture, moves int) {
	t.Helper()
	awaitCoreApp(t, a, func() bool { return !a.corePending })
	if len(coreRequests(f, "doc.set")) != moves || len(coreRequests(f, "terminal.run"))+len(coreRequests(f, "terminal.kill")) != 0 || a.coreCapture != nil || a.returnFocus || a.coreSelection.Tab != "t1" {
		t.Fatal("drag navigated or dispatched extra mutation", a.coreSelection, moves, len(coreRequests(f, "doc.set")))
	}
	for _, m := range a.machines {
		if len(m.coreSeen) != 0 {
			t.Fatal("drag acknowledged visit")
		}
	}
	noCoreData(t, f)
	noLegacyNavigation(t, f)
}
func tabGesture(t *testing.T, tt *ui.Tester, source, target string) {
	t.Helper()
	s := find(t, tt, "tab/"+source)
	d := find(t, tt, target)
	tt.Press(s.X+20, s.Y+14)
	tt.Move(s.X+40, s.Y+14)
	tt.Move(d.X+10, d.Y+14)
	tt.Release(d.X+10, d.Y+14)
	tt.Frame()
}
func startTabGesture(t *testing.T, a *App, tt *ui.Tester, afterThreshold bool) {
	t.Helper()
	src := find(t, tt, "tab/t1")
	tt.Press(src.X+20, src.Y+14)
	if afterThreshold {
		tt.Move(src.X+40, src.Y+14)
	}
	a.mu.Lock()
	d := a.activeTabDrag
	armed := d != nil && !d.canceled && d.tabID == "t1"
	a.mu.Unlock()
	if !armed {
		t.Fatal("real pointer gesture did not capture origin")
	}
}

func finishTabGesture(t *testing.T, tt *ui.Tester, finish, source string) {
	t.Helper()
	src := find(t, tt, "tab/"+source)
	tt.Press(src.X+20, src.Y+14)
	tt.Move(src.X+40, src.Y+14)
	dst := find(t, tt, "tab/t3")
	switch finish {
	case "end":
		dst = find(t, tt, "New tab")
	case "self":
		dst = src
	case "outside":
		tt.Move(500, 500)
		tt.Release(500, 500)
		return
	}
	tt.Move(dst.X+10, dst.Y+14)
	if finish == "escape" {
		tt.Key(0, ui.KeyEscape)
	}
	tt.Release(dst.X+10, dst.Y+14)
	tt.Frame()
}

func TestTabDragRetainsControlKeyboardOwner(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		for _, owner := range []string{"machine: Local", "tab/t1"} {
			for _, finish := range []string{"move", "end", "self", "outside", "escape"} {
				t.Run(style+owner+finish, func(t *testing.T) {
					a, f, _, tt := tabDragFixture(t, style)
					focusNavigationControl(t, tt, owner)
					finishTabGesture(t, tt, finish, "t2")
					moves := 0
					if finish == "move" || finish == "end" {
						moves = 1
						want := []string{"t1", "t3", "t2", "t4"}
						if finish == "end" {
							want = []string{"t1", "t3", "t4", "t2"}
						}
						wantTabOrder(t, a, tt, want...)
					}
					if !tt.Focused(owner) {
						t.Fatal("drag stole control owner")
					}
					if active, _ := tt.TextInputActive(); active {
						t.Fatal("control drag enabled native terminal text")
					}
					tabDragOnly(t, a, f, moves)
				})
			}
		}
	}
}
func invalidateCoreTab(t *testing.T, a *App, f *coreAppFixture, tt *ui.Tester, update func(func(*core.Layout)), change string) func() {
	t.Helper()
	original, _ := json.Marshal(a.coreState.Layout)
	restore := func() { update(func(l *core.Layout) { json.Unmarshal(original, l) }) }
	switch change {
	case "program":
		f.mu.Lock()
		r := f.terminals["p-t1"]
		f.mu.Unlock()
		f.report("restarted", r)
		awaitCoreApp(t, a, func() bool { return a.coreState.Programs["p-t1"] > 0 })
	case "reference":
		update(func(l *core.Layout) { l.Pane("p-t1").Terminal.Address = "replacement" })
	case "tab-moved":
		update(func(l *core.Layout) {
			tab := l.Workspaces[0].Tabs[0]
			l.Workspaces[0].Tabs = l.Workspaces[0].Tabs[1:]
			l.Workspaces = append(l.Workspaces, core.Workspace{ID: "other", Tabs: []core.Tab{tab}})
		})
	case "workspace":
		update(func(l *core.Layout) { l.Workspaces[0].ID = "other" })
	case "source-removal":
		update(func(l *core.Layout) { l.Workspaces[0].Tabs = l.Workspaces[0].Tabs[1:] })
	case "machine":
		old := a.machine
		coreAppAct(a, func() { a.machine = newMachine(nil); a.checkTabDrag() })
		return func() { coreAppAct(a, func() { a.machine = old; a.coreChrome() }) }
	}
	return restore
}
func TestTabDragInvalidOwnerCannotResurrect(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		for _, after := range []bool{false, true} {
			for _, change := range []string{"program", "reference", "workspace", "tab-moved", "source-removal", "machine"} {
				t.Run(fmt.Sprint(style, after, change), func(t *testing.T) {
					a, f, update, tt := tabDragFixture(t, style)
					startTabGesture(t, a, tt, after)
					restore := invalidateCoreTab(t, a, f, tt, update, change)
					tt.Frame()
					restore()
					tt.Frame()
					d := find(t, tt, "tab/t3")
					tt.Move(d.X+10, d.Y+14)
					tt.Release(d.X+10, d.Y+14)
					tt.Frame()
					if len(coreRequests(f, "doc.set")) != 0 {
						t.Fatal("old source dispatched CAS")
					}
					noCoreData(t, f)
					finishTabGesture(t, tt, "move", "t1")
					wantTabOrder(t, a, tt, "t2", "t3", "t1", "t4")
					if len(coreRequests(f, "doc.set")) != 1 {
						t.Fatal("fresh source failed to recover")
					}
					noCoreData(t, f)
				})
			}
		}
	}
}
func TestTabDragTransientSnapshotInvalidation(t *testing.T) {
	for _, change := range []string{"program", "workspace", "source-removal", "reference"} {
		t.Run(change, func(t *testing.T) {
			a, f, update, tt := tabDragFixture(t, paneComfortable)
			startTabGesture(t, a, tt, true)
			restore := invalidateCoreTab(t, a, f, tt, update, change)
			restore()
			tt.Frame()
			d := find(t, tt, "tab/t3")
			tt.Move(d.X+10, d.Y+14)
			tt.Release(d.X+10, d.Y+14)
			if len(coreRequests(f, "doc.set")) != 0 {
				t.Fatal("transient invalidation revived old press")
			}
			noCoreData(t, f)
		})
	}
}
func TestTabDragUsesLiveIndicesAndEndGap(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		for _, end := range []bool{false, true} {
			t.Run(fmt.Sprint(style, end), func(t *testing.T) {
				a, f, update, tt := tabDragFixture(t, style)
				startTabGesture(t, a, tt, true)
				update(func(l *core.Layout) {
					slices.Reverse(l.Workspaces[0].Tabs)
					if end {
						p := core.NewPane(core.TerminalRef{CoreID: l.CoreID, Address: "new"})
						l.AddTab("w1", "t5", p)
					}
				})
				tt.Frame()
				target := "tab/t3"
				want := []string{"t4", "t1", "t3", "t2"}
				if end {
					target = "New tab"
					before := tabOrder(a)
					want = append(slices.Delete(before, 3, 4), "t1")
				}
				d := find(t, tt, target)
				tt.Move(d.X+10, d.Y+14)
				tt.Release(d.X+10, d.Y+14)
				wantTabOrder(t, a, tt, want...)
				if len(coreRequests(f, "doc.set")) != 1 {
					t.Fatal("live drop did not use one CAS")
				}
				noCoreData(t, f)
			})
		}
	}
}
func TestTabDragRemovedTargetDoesNotDispatch(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		a, f, update, tt := tabDragFixture(t, style)
		startTabGesture(t, a, tt, true)
		d := find(t, tt, "tab/t3")
		tt.Move(d.X+10, d.Y+14)
		update(func(l *core.Layout) { l.Workspaces[0].Tabs = slices.Delete(l.Workspaces[0].Tabs, 2, 3) })
		tt.ReleaseUnframed(d.X+10, d.Y+14)
		tt.Frame()
		tabDragOnly(t, a, f, 0)
	}
}
func TestTabDragLeavesOrdinaryTabActions(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		for _, action := range []string{"click", "close", "menu", "enter", "space", "shortcut"} {
			t.Run(style+action, func(t *testing.T) {
				a, f, _, tt := tabDragFixture(t, style)
				switch action {
				case "click":
					r := find(t, tt, "tab/t2")
					tt.Press(r.X+20, r.Y+14)
					tt.Move(r.X+21, r.Y+14)
					tt.Release(r.X+21, r.Y+14)
				case "close":
					r := find(t, tt, "tab/t2")
					tt.Move(r.X+r.W-15, r.Y+14)
					b := find(t, tt, "close/t2")
					tt.ClickAt(b.X+b.W/2, b.Y+b.H/2)
					if a.dialog == nil {
						t.Fatal("close lost confirmation")
					}
					if err := tt.Click("Close"); err != nil {
						t.Fatal(err)
					}
					wantTabOrder(t, a, tt, "t1", "t3", "t4")
					noCoreData(t, f)
					return
				case "menu":
					tt.RightClick("tab/t1")
					if err := tt.ChooseMenuItem("Move right"); err != nil {
						t.Fatal(err)
					}
					wantTabOrder(t, a, tt, "t2", "t1", "t3", "t4")
					tabDragOnly(t, a, f, 1)
					return
				case "enter", "space":
					focusNavigationControl(t, tt, "tab/t1")
					tt.Key(0, ui.KeyRight)
					if !tt.Focused("tab/t2") {
						t.Fatal("roving focus wrong")
					}
					key := ui.KeyEnter
					if action == "space" {
						key = ui.KeySpace
					}
					tt.Key(0, key)
				case "shortcut":
					tt.Key(ui.Cmd, ui.Key2)
				}
				if a.coreSelection.Tab != "t2" {
					t.Fatal("explicit activation failed")
				}
				readyCorePane(t, a, tt, "p-t2")
				if !tt.TypeKeyNative(0, ui.KeyX, "x") {
					t.Fatal("explicit activation lost native owner")
				}
				wantCorePaneInput(t, f, "p-t2", "x")
				if len(coreRequests(f, "doc.set")) != 0 {
					t.Fatal("activation mutated topology")
				}
				noCoreData(t, f)
			})
		}
	}
}

func TestTabDragConflictKeepsWinnerAndKeyboardOwner(t *testing.T) {
	a, f, _, tt := tabDragFixture(t, paneComfortable)
	original := tabOrder(a)
	f.mu.Lock()
	f.failOnce = map[string]string{"doc.set": "conflict"}
	f.mu.Unlock()
	finishTabGesture(t, tt, "move", "t1")
	awaitCoreApp(t, a, func() bool { return a.navigationNote != "" })
	tt.Frame()
	if !slices.Equal(tabOrder(a), original) || len(coreRequests(f, "doc.set")) != 1 || !tt.Focused("terminal/p-t1") {
		t.Fatal("conflict replayed or stole owner")
	}
	tt.Type("later")
	wantCorePaneInput(t, f, "p-t1", "later")
	noCoreData(t, f)
}
func TestTabDragLaterModalKeepsItsNativeOwner(t *testing.T) {
	a, f, _, tt := tabDragFixture(t, paneComfortable)
	startTabGesture(t, a, tt, true)
	coreAppAct(a, func() { a.askInWindow("Rename", "", false, func(string) {}) })
	tt.Frame()
	d := find(t, tt, "tab/t3")
	tt.Move(d.X+10, d.Y+14)
	tt.Release(d.X+10, d.Y+14)
	tt.Frame()
	if !tt.TypeKeyNative(0, ui.KeyX, "x") || !tt.Focused("Rename") || a.dialog.value != "x" {
		t.Fatal("drag completion stole modal owner")
	}
	noCoreData(t, f)
}
