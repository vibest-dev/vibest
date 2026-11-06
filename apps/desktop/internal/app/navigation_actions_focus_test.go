package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
	"vibest-desktop/internal/core"
)

func TestDispatchedNavigationRestoresPaneFocus(t *testing.T) {
	for _, action := range []struct {
		name, button, menu, dest string
		mods                     ui.Modifiers
		key                      ui.Key
		create                   bool
	}{{name: "new-workspace-button", button: "new-workspace", create: true}, {name: "new-tab-button", button: "New tab", create: true}, {name: "new-workspace-key", mods: ui.Cmd, key: ui.KeyN, create: true}, {name: "new-tab-key", mods: ui.Cmd, key: ui.KeyT, create: true}, {name: "tab-number", mods: ui.Cmd, key: ui.Key2, dest: "c"}, {name: "selected-tab-number", mods: ui.Cmd, key: ui.Key1, dest: "a"}, {name: "next-tab", mods: ui.Cmd | ui.Shift, key: ui.KeyBracketRight, dest: "c"}, {name: "previous-tab", mods: ui.Cmd | ui.Shift, key: ui.KeyBracketLeft, dest: "c"}, {name: "pane-direction", mods: ui.Cmd | ui.Alt, key: ui.KeyRight, dest: "b"}, {name: "split-key", mods: ui.Cmd, key: ui.KeyD, create: true}, {name: "split-down-key", mods: ui.Cmd | ui.Shift, key: ui.KeyD, create: true}, {name: "split-menu", menu: "Split right", create: true}, {name: "split-down-menu", menu: "Split down", create: true}} {
		for _, origin := range []string{"pane", "control"} {
			t.Run(action.name+"/"+origin, func(t *testing.T) {
				a, f, tt := coreActivityUI(t)
				if origin == "control" {
					focusNavigationControl(t, tt, "machine: Local")
				}
				switch {
				case action.button != "":
					if err := tt.Click(action.button); err != nil {
						t.Fatal(err)
					}
				case action.menu != "":
					if err := tt.RightClick("terminal/a"); err != nil {
						t.Fatal(err)
					}
					if err := tt.ChooseMenuItem(action.menu); err != nil {
						t.Fatal(err)
					}
				default:
					tt.Key(action.mods, action.key)
				}
				id, address := action.dest, action.dest
				if action.create {
					awaitCoreApp(t, a, func() bool { return !a.corePending && a.coreSelection.Pane != "a" })
					id = a.coreSelection.Pane
					coreAppAct(a, func() {
						p := a.coreState.Layout.Pane(id)
						address = p.Terminal.Address
						if address != "t5" {
							t.Fatal("creation not bound to returned terminal")
						}
					})
					if len(coreRequests(f, "terminal.run")) != 1 || len(coreRequests(f, "doc.set")) != 1 {
						t.Fatal("missing creation/CAS")
					}
				} else if a.coreSelection.Pane != id {
					t.Fatal("local navigation failed", a.coreSelection, id)
				}
				readyCorePane(t, a, tt, id)
				if !tt.Focused("terminal/" + id) {
					t.Fatal("navigation lost keyboard focus")
				}
				for range 2 {
					tt.TypeKeyNative(0, ui.KeyX, "x")
					wantCorePaneInput(t, f, address, "x")
					tt.Frame()
				}
				noCoreData(t, f)
				noLegacyNavigation(t, f)
			})
		}
	}
}
func TestHoveredPaneMenuNavigationRestoresFocus(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	awaitCorePaintWithoutOwnership(t, a, tt, "b")
	old := a.coreViews["a"]
	focusNavigationControl(t, tt, "machine: Local")
	if err := tt.RightClick("terminal/b"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Split right"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return !a.corePending && a.coreSelection.Pane != "a" })
	id := a.coreSelection.Pane
	coreAppAct(a, func() {
		root := a.coreState.Layout.Tab("t1").Root
		if root.First.Pane == nil || root.First.Pane.ID != "a" || root.Second.First.Pane.ID != "b" || root.Second.Second.Pane.ID != id || a.coreViews["a"] != old {
			t.Fatal("menu did not split hovered b independently")
		}
	})
	readyCorePane(t, a, tt, id)
	tt.Type("x")
	wantCorePaneInput(t, f, "t5", "x")
	tt.Frame()
	tt.Type("y")
	wantCorePaneInput(t, f, "t5", "y")
}
func noticeCoreUI(t *testing.T) (*App, *coreAppFixture, *ui.Tester) {
	t.Helper()
	return coreActivityUIWith(t, func(f *coreAppFixture) {
		p := core.NewPane(core.TerminalRef{CoreID: "remote-A", Address: "rohan/r"})
		p.ID = "r"
		f.layout.AddWorkspace("Remote", "/inert", "rohan", p)
		f.machines = []core.MachineView{{Name: "rohan", ID: "remote-A", State: "connected"}}
		f.terminals["remote-A/r"] = core.Terminal{Address: "rohan/r", State: "live", Cols: 80, Rows: 24}
	})
}
func TestNotificationNavigationRestoresPaneFocus(t *testing.T) {
	for _, id := range []string{"c", "rohan/r"} {
		t.Run(id, func(t *testing.T) {
			a, f, tt := noticeCoreUI(t)
			focusNavigationControl(t, tt, "machine: Local")
			a.ShowNotice(id)
			tt.Frame()
			if id == "c" {
				readyCorePane(t, a, tt, "c")
				tt.Type("x")
				wantCorePaneInput(t, f, "c", "x")
			} else {
				awaitCorePaintWithoutOwnership(t, a, tt, "r")
				tt.TypeKeyNative(0, ui.KeyX, "x")
				if a.coreSelection.Pane != "r" || a.coreViews["r"].InputReady() || !notes(tt, core.ErrRemoteInput.Error()) {
					t.Fatal("remote notice lost selection or violated read-only contract")
				}
				noCoreData(t, f)
			}
		})
	}
}
func TestNotificationNavigationPreservesModalControl(t *testing.T) {
	for _, kind := range []string{"rename", "confirmation"} {
		for _, id := range []string{"c", "missing", "rohan/r", "rohan/missing"} {
			t.Run(kind+"/"+id, func(t *testing.T) {
				a, f, tt := noticeCoreUI(t)
				accepted, canceled := false, false
				label := "Cancel"
				coreAppAct(a, func() {
					if kind == "rename" {
						a.askInWindow("Rename", "keep", false, func(string) { accepted = true })
						a.dialog.cancel = func() { canceled = true }
					} else {
						label = "Close"
						a.confirmInWindow("Close pane?", "", "Close", func() { accepted = true }, func() { canceled = true })
					}
				})
				d := a.dialog
				tt.Frame()
				tt.Key(0, ui.KeyTab)
				if !tt.Focused(label) {
					t.Fatal("modal control not focused")
				}
				a.ShowNotice(id)
				tt.Frame()
				value := d.value
				tt.TypeKeyNative(0, ui.KeyX, "x")
				if !tt.Focused(label) || d.value != value || a.dialog != d || !d.open || accepted || canceled {
					t.Fatal("notice replaced intentional modal owner")
				}
				noCoreData(t, f)
				tt.Key(0, ui.KeyEnter)
				if accepted != (kind == "confirmation") || canceled != (kind == "rename") {
					t.Fatal("modal action routing changed")
				}
			})
		}
	}
}
func TestUndispatchedNavigationPreservesFocus(t *testing.T) {
	for _, path := range []string{"unbound-number", "single-tab", "modal", "unknown-notification"} {
		t.Run(path, func(t *testing.T) {
			a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
				if path == "single-tab" {
					f.layout.Workspaces[0].Tabs = f.layout.Workspaces[0].Tabs[:1]
				}
			})
			focusNavigationControl(t, tt, "machine: Local")
			label := "machine: Local"
			switch path {
			case "unbound-number":
				tt.Key(ui.Cmd, ui.Key9)
			case "single-tab":
				tt.Key(ui.Cmd|ui.Shift, ui.KeyBracketRight)
			case "modal":
				coreAppAct(a, func() { a.askInWindow("Rename", "", false, func(string) {}) })
				tt.Frame()
				label = "Rename"
				tt.Key(ui.Cmd, ui.KeyN)
			case "unknown-notification":
				a.ShowNotice("unknown/pane")
				tt.Frame()
			}
			if !tt.Focused(label) || a.returnFocus || a.coreSelection.Pane != "a" || len(coreRequests(f, "terminal.run"))+len(coreRequests(f, "doc.set")) != 0 {
				t.Fatal("undispatched action changed focus or dispatched mutation")
			}
			noCoreData(t, f)
		})
	}
}
