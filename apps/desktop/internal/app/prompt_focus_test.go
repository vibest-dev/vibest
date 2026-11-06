package app

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestRenameDismissalRestoresPaneInput(t *testing.T) {
	for _, origin := range []string{"pane", "menu"} {
		for _, dismiss := range []string{"submit", "OK", "Cancel", "escape", "outside"} {
			t.Run(origin+"/"+dismiss, func(t *testing.T) {
				app, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
				v := coreOutput(t, app, f, tt, "a", "KEEP THIS LINE\r\nnext")
				ran := false
				if origin == "menu" {
					if err := tt.RightClick("terminal/a"); err != nil {
						t.Fatal(err)
					}
					if err := tt.ChooseMenuItem("Rename pane"); err != nil {
						t.Fatal(err)
					}
				} else {
					app.ask("Rename pane", "", false, func(v string) {
						ran = true
						if v != "name" {
							t.Errorf("rename got %q, want name", v)
						}
					})
					tt.Frame()
				}
				if !tt.Focused("Rename pane") {
					t.Fatal("rename field lacks focus")
				}
				tt.Type("name")
				tt.Key(ui.Cmd, ui.KeyK)
				noCoreData(t, f)
				if !strings.Contains(v.VT.Text(), "KEEP THIS LINE") {
					t.Fatal("dialog Cmd+K cleared terminal")
				}
				switch dismiss {
				case "submit":
					tt.Key(0, ui.KeyEnter)
				case "escape":
					tt.Key(0, ui.KeyEscape)
				case "outside":
					tt.ClickAt(5, 5)
				default:
					if err := tt.Click(dismiss); err != nil {
						t.Fatal(err)
					}
				}
				tt.Frame()
				if app.dialog != nil {
					t.Fatal("rename not dismissed")
				}
				confirmed := dismiss == "submit" || dismiss == "OK"
				if origin == "pane" && ran != confirmed {
					t.Fatalf("rename callback ran=%v", ran)
				}
				if origin == "menu" && confirmed {
					awaitCoreApp(t, app, func() bool { return app.coreState.Layout.Pane("a").Label == "name" })
				}
				tt.TypeKeyNative(0, ui.KeyX, "x")
				readyCorePane(t, app, tt, "a")
				wantCorePaneInput(t, f, "a", "x")
				tt.Key(ui.Cmd, ui.KeyK)
				if strings.Contains(v.VT.Text(), "KEEP THIS LINE") {
					t.Fatal("restored local clear failed")
				}
				noCoreData(t, f)
			})
		}
	}
}

func TestRenameDismissalKeepsNewFocus(t *testing.T) {
	for _, next := range []string{"dialog", "input"} {
		t.Run(next, func(t *testing.T) {
			app, f, _ := coreShellFixture(t, 1280, 800, 1, false, "single")
			intentional, value := false, ""
			tt := ui.NewTester(func(c *ui.Context) {
				app.View(c)
				if intentional {
					ui.TextInput(c, &value).Label("Intentional input").Focus()
				}
			}, 1280, 800)
			app.ask("Rename pane", "", false, func(string) {})
			tt.Frame()
			tt.Key(0, ui.KeyEscape)
			if next == "dialog" {
				app.ask("Another rename", "", false, func(string) {})
			} else {
				intentional = true
			}
			tt.Frame()
			tt.Type("x")
			noCoreData(t, f)
			if next == "dialog" {
				if !tt.Focused("Another rename") || app.dialog.value != "x" {
					t.Fatal("replacement dialog lost focus")
				}
			} else if !tt.Focused("Intentional input") || value != "x" {
				t.Fatal("intentional input lost focus")
			}
		})
	}
}
