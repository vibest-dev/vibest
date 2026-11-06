package app

import (
	"errors"
	"github.com/egoist/mygo/ui"
	"strings"
	"testing"
	"time"
	"vibest-desktop/internal/core"
)

func coreMachineUI(t *testing.T) (*App, *coreAppFixture, *ui.Tester) {
	t.Helper()
	return coreActivityUIWith(t, func(f *coreAppFixture) {
		f.machines = []core.MachineView{{Name: "Remote", ID: "remote-A", State: "connected"}}
		w := &f.layout.Workspaces[1]
		w.Label, w.Machine = "Remote Alpha", "Remote"
		w.Tabs[0].Root.Pane.Terminal = core.TerminalRef{CoreID: "remote-A", Address: "Remote/r"}
		delete(f.terminals, "d")
		f.terminals["remote-A/r"] = core.Terminal{Address: "Remote/r", State: "live", Cols: 80, Rows: 24}
		f.terminals["remote-A/s"] = core.Terminal{Address: "Remote/s", State: "live", Cols: 80, Rows: 24}
		f.layout.Workspaces = append(f.layout.Workspaces, core.Workspace{ID: "wr2", Label: "Remote Bravo", Machine: "Remote", Tabs: []core.Tab{{ID: "tr2", Root: &core.Split{Pane: &core.Pane{ID: "r2", Terminal: core.TerminalRef{CoreID: "remote-A", Address: "Remote/s"}}}}}})
	})
}
func wantRemoteNavigation(t *testing.T, a *App, f *coreAppFixture, tt *ui.Tester, id string) {
	t.Helper()
	tt.Frame()
	if a.coreSelection.Pane != id {
		t.Fatalf("machine activation chose %s, want %s", a.coreSelection.Pane, id)
	}
	awaitCorePaintWithoutOwnership(t, a, tt, id)
	v := a.coreViews[id]
	if a.coreSelection.Pane != id || a.machine.id() != "Remote" || v.InputReady() || !errors.Is(v.InputError(), core.ErrRemoteInput) || !tt.HasText(core.ErrRemoteInput.Error()) {
		t.Fatal("remote destination/visible read-only contract lost", a.coreSelection, tt.Texts())
	}
	if tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("remote claimed native text eligibility")
	}
	tt.Type("synthetic refused")
	v.VT.Paste("paste refused")
	noCoreData(t, f)
	noLegacyNavigation(t, f)
}
func focusNavigationControl(t *testing.T, tt *ui.Tester, row string) {
	t.Helper()
	if strings.HasPrefix(row, "tab/") {
		focusNavigationControl(t, tt, "machine: Local")
		for range 128 {
			tt.Key(0, ui.KeyTab)
			if tt.Focused(row) {
				return
			}
			for _, label := range tt.Texts() {
				if strings.HasPrefix(label, "tab/") && tt.Focused(label) {
					for range 128 {
						tt.Key(0, ui.KeyRight)
						if tt.Focused(row) {
							return
						}
					}
					t.Fatalf("tab focus group did not reach %q", row)
				}
			}
		}
		t.Fatalf("keyboard traversal did not focus %q", row)
	}
	r := find(t, tt, row)
	tt.Press(r.X+r.W/2, r.Y+r.H/2)
	tt.Release(-10, -10)
	if !tt.Focused(row) {
		t.Fatalf("pointer press did not focus %q", row)
	}
}
func TestMachineNavigationRestoresPaneFocus(t *testing.T) {
	for _, row := range []string{"machine: Remote", "machine: Local", "Remote Bravo"} {
		for _, activation := range []string{"pointer", "enter", "space"} {
			t.Run(row+"/"+activation, func(t *testing.T) {
				a, f, tt := coreMachineUI(t)
				if activation == "pointer" {
					navigationRelease(t, tt, row)
				} else {
					focusNavigationControl(t, tt, row)
					key := ui.KeyEnter
					if activation == "space" {
						key = ui.KeySpace
					}
					tt.Key(0, key)
				}
				if row == "machine: Local" {
					if !tt.TypeKeyNative(0, ui.KeyX, "x") {
						t.Fatal("local first native character lost")
					}
					readyCorePane(t, a, tt, "a")
					wantCorePaneInput(t, f, "a", "x")
				} else {
					id := "d"
					if row == "Remote Bravo" {
						id = "r2"
					}
					wantRemoteNavigation(t, a, f, tt, id)
					navigationRelease(t, tt, "machine: Remote")
					wantRemoteNavigation(t, a, f, tt, id)
					navigationRelease(t, tt, "machine: Local")
					tt.TypeKeyNative(0, ui.KeyX, "x")
					readyCorePane(t, a, tt, "a")
					wantCorePaneInput(t, f, "a", "x")
				}
				noCoreData(t, f)
			})
		}
	}
	for _, target := range []string{"Remote/r2", "b"} {
		t.Run("notice/"+target, func(t *testing.T) {
			a, f, tt := coreMachineUI(t)
			a.ShowNotice(target)
			tt.Frame()
			if target == "Remote/r2" {
				wantRemoteNavigation(t, a, f, tt, "r2")
			} else {
				tt.TypeKeyNative(0, ui.KeyX, "x")
				readyCorePane(t, a, tt, "b")
				wantCorePaneInput(t, f, "b", "x")
			}
		})
	}
}
func TestRapidMachineNavigationKeepsPaneInput(t *testing.T) {
	a, f, tt := coreMachineUI(t)
	remembered := "d"
	local := a.coreViews["a"]
	for range 5 {
		navigationRelease(t, tt, "machine: Remote")
		wantRemoteNavigation(t, a, f, tt, remembered)
		navigationRelease(t, tt, "Remote Bravo")
		wantRemoteNavigation(t, a, f, tt, "r2")
		a.ShowNotice("Remote/r2")
		tt.Frame()
		wantRemoteNavigation(t, a, f, tt, "r2")
		coreOutput(t, a, f, tt, "d", "old viewer output")
		if a.coreSelection.Pane != "r2" {
			t.Fatal("background output changed local selection")
		}
		navigationRelease(t, tt, "machine: Local")
		tt.TypeKeyNative(0, ui.KeyX, "x")
		readyCorePane(t, a, tt, "a")
		wantCorePaneInput(t, f, "a", "x")
		if a.coreViews["a"] != local {
			t.Fatal("machine navigation replaced local VT")
		}
		remembered = "r2"
	}
	noCoreData(t, f)
}
func TestNavigationResponsesPreserveIntentionalFocus(t *testing.T) {
	for _, navigate := range []bool{false, true} {
		for _, focus := range []string{"pane", "row", "rename", "confirm"} {
			t.Run(focus+map[bool]string{false: "/local", true: "/remote"}[navigate], func(t *testing.T) {
				a, f, tt := coreMachineUI(t)
				id := "a"
				if navigate {
					a.ShowNotice("Remote/r2")
					tt.Frame()
					wantRemoteNavigation(t, a, f, tt, "r2")
					id = "r2"
				}
				label := ""
				switch focus {
				case "row":
					label = "machine: Local"
					focusNavigationControl(t, tt, label)
				case "rename":
					label = "Rename"
					coreAppAct(a, func() { a.askInWindow(label, "", false, func(string) {}) })
				case "confirm":
					label = "Cancel"
					coreAppAct(a, func() { a.confirmInWindow("Close pane?", "", "Close", func() {}, nil) })
				}
				tt.Frame()
				reportActivity(t, a, f, "b", "working", 5, true)
				coreOutput(t, a, f, tt, id, "background report remains output")
				if focus == "pane" {
					if navigate {
						wantRemoteNavigation(t, a, f, tt, id)
					} else {
						tt.TypeKeyNative(0, ui.KeyX, "x")
						wantCorePaneInput(t, f, "a", "x")
					}
					return
				}
				tt.TypeKeyNative(0, ui.KeyX, "x")
				tt.Frame()
				if !tt.Focused(label) {
					t.Fatal("late output/report stole intentional focus", label)
				}
				if focus == "rename" && a.dialog.value != "x" {
					t.Fatal("dialog lost native text")
				}
				noCoreData(t, f)
			})
		}
	}
}
func TestUncachedMachineNavigationPreservesDialogFocus(t *testing.T) {
	a, f, tt := coreMachineUI(t)
	release, held := holdCoreMethod(t, f, "terminal.attach remote-A/r")
	navigationRelease(t, tt, "machine: Remote")
	tt.Frame()
	select {
	case <-held:
	case <-time.After(time.Second):
		t.Fatal("remote attach did not reach barrier")
	}
	coreAppAct(a, func() { a.askInWindow("Rename", "", false, func(string) {}) })
	tt.Frame()
	release()
	awaitCorePaintWithoutOwnership(t, a, tt, "d")
	if !tt.TypeKeyNative(0, ui.KeyX, "x") || !tt.Focused("Rename") || a.dialog.value != "x" {
		t.Fatal("first remote paint stole dialog owner")
	}
	noCoreData(t, f)
}
