package app

import (
	"testing"
)

func TestNavigationRestoresPaneFocus(t *testing.T) {
	for _, path := range []string{"workspace", "tab"} {
		for _, focus := range []string{"pane", "rename", "confirm", "selected"} {
			t.Run(path+"/"+focus, func(t *testing.T) {
				a, f, tt := coreActivityUI(t)
				row, id := "Other", "d"
				if path == "tab" {
					row, id = "tab/t2", "c"
				}
				if focus == "selected" {
					row, id = "Repo", "a"
					if path == "tab" {
						row = "tab/t1"
					}
					if err := tt.Click(row); err != nil {
						t.Fatal(err)
					}
					readyCorePane(t, a, tt, id)
					tt.Type("x")
					wantCorePaneInput(t, f, id, "x")
					noLegacyNavigation(t, f)
					return
				}
				release, held := holdCoreMethod(t, f, "terminal.attach "+id)
				if err := tt.Click(row); err != nil {
					t.Fatal(err)
				}
				<-held
				if !terminalInputFocused(tt) {
					t.Fatal("navigation control retained keyboard")
				}
				if focus != "pane" {
					coreAppAct(a, func() {
						if focus == "rename" {
							a.askInWindow("Rename", "", false, func(string) {})
						} else {
							a.confirmInWindow("Close pane?", "", func() {}, nil)
						}
					})
					tt.Frame()
				}
				release()
				if focus == "pane" {
					readyCorePane(t, a, tt, id)
					tt.Type("x")
					wantCorePaneInput(t, f, id, "x")
				} else {
					awaitCorePaintWithoutOwnership(t, a, tt, id)
					tt.Type("x")
					label := "Cancel"
					if focus == "rename" {
						label = "Rename"
						if a.dialog.value != "x" {
							t.Fatal("rename did not own text")
						}
					}
					if !tt.Focused(label) {
						t.Fatal("delayed readiness stole modal")
					}
					noCoreData(t, f)
				}
			})
		}
	}
}
