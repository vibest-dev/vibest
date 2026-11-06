package app

import (
	"github.com/egoist/mygo/ui"
	"strings"
	"testing"
)

func TestFirstSnapshotDismissalRestoresViewerInput(t *testing.T) {
	for _, origin := range []string{"attach", "creation"} {
		for _, dismiss := range []string{"rename-Cancel", "rename-Escape", "rename-confirm", "confirmation-Close", "confirmation-Cancel"} {
			t.Run(origin+"/"+dismiss, func(t *testing.T) {
				a, f, tt, release, target := delayedCoreDestination(t, origin)
				ran := false
				choice := "Cancel"
				coreAppAct(a, func() {
					if strings.HasPrefix(dismiss, "confirmation") {
						a.confirmInWindow("Later confirmation", "", func() { ran = true }, nil)
						if dismiss == "confirmation-Close" {
							choice = "Close"
						}
					} else {
						a.askInWindow("Later rename", "name", false, func(string) { ran = true })
						if dismiss == "rename-confirm" {
							choice = "OK"
						}
					}
				})
				tt.Frame()
				for i := 0; i < 3 && !tt.Focused(choice); i++ {
					tt.Key(0, ui.KeyTab)
				}
				if !tt.Focused(choice) {
					t.Fatal("could not select " + choice)
				}
				release()
				id := target()
				awaitCorePaintWithoutOwnership(t, a, tt, id)
				key := ui.KeyEnter
				if dismiss == "rename-Escape" {
					key = ui.KeyEscape
				}
				tt.Key(0, key)
				view := readyCorePane(t, a, tt, id)
				if a.dialog != nil || ran != (choice == "OK" || choice == "Close") {
					t.Fatal("modal dismissal changed choice")
				}
				coreOutput(t, a, f, tt, id, "\r\nclear this marker\r\n")
				tt.Key(ui.Cmd, ui.KeyK)
				tt.TypeKey(0, ui.KeyX, "x")
				got := wantCoreInput(t, f, "x")
				a.mu.Lock()
				ref := a.coreAttached[id]
				a.mu.Unlock()
				f.mu.Lock()
				want := f.channels[ref.Address]
				f.mu.Unlock()
				if got != want {
					t.Fatal("dismissal typed into old pane")
				}
				if strings.Contains(view.VT.Text(), "clear this marker") {
					t.Fatal("first Cmd+K did not clear current VT locally")
				}
				noLegacyNavigation(t, f)
				focusNavigationControl(t, tt, "machine: Local")
				reportActivity(t, a, f, "a", "idle", 1, true)
				tt.Frame()
				if a.returnFocus || !tt.Focused("machine: Local") {
					t.Fatal("dismissal repeated its one-shot handoff")
				}
			})
		}
	}
}
func TestFirstSnapshotDismissalPreservesReplacementDialog(t *testing.T) {
	for _, dismiss := range []string{"confirm", "cancel"} {
		t.Run(dismiss, func(t *testing.T) {
			a, f, tt, release, target := delayedCoreDestination(t, "attach")
			replaced := 0
			replace := func() { replaced++; a.askInWindow("Next rename", "", false, func(string) {}) }
			coreAppAct(a, func() {
				if dismiss == "confirm" {
					a.askInWindow("First rename", "", false, func(string) { replace() })
				} else {
					a.confirmInWindow("First confirmation", "", func() {}, replace)
				}
			})
			tt.Frame()
			release()
			id := target()
			awaitCorePaintWithoutOwnership(t, a, tt, id)
			key := ui.KeyEnter
			if dismiss == "cancel" {
				key = ui.KeyEscape
			}
			tt.Key(0, key)
			tt.Frame()
			tt.TypeKey(0, ui.KeyX, "x")
			tt.Key(ui.Cmd, ui.KeyK)
			if replaced != 1 || a.dialog == nil || a.dialog.title != "Next rename" || a.dialog.value != "x" || !tt.Focused("Next rename") || a.returnFocus {
				t.Fatalf("replacement lost ownership: count=%d dialog=%+v returnFocus=%v", replaced, a.dialog, a.returnFocus)
			}
			select {
			case p := <-f.inputs:
				t.Fatalf("replacement leaked %q", p.body)
			default:
			}
		})
	}
}
