package app

import (
	"github.com/egoist/mygo/ui"
	"strings"
	"testing"
)

func TestNavigationFirstNativeCharacterExclusiveEndpoint(t *testing.T) {
	_, fa, ta := coreActivityUI(t)
	_, fb, tb := coreActivityUI(t)
	for _, step := range []struct {
		tt       *ui.Tester
		f, other *coreAppFixture
	}{{tb, fb, fa}, {ta, fa, fb}, {ta, fa, fb}, {tb, fb, fa}} {
		navigationRelease(t, step.tt, "tab/t1")
		if !step.tt.TypeKeyNative(0, ui.KeyX, "x") {
			t.Fatal("first native character ineligible")
		}
		wantCorePaneInput(t, step.f, "a", "x")
		noCoreData(t, step.other)
		noCoreData(t, step.f)
	}
}
func TestNavigationHoldsSemanticOrderUntilAcknowledged(t *testing.T) {
	for _, path := range []string{"tab", "workspace"} {
		for _, activation := range []string{"pointer", "enter", "shortcut"} {
			if path == "workspace" && activation == "shortcut" {
				continue
			}
			t.Run(path+"/"+activation, func(t *testing.T) {
				a, f, tt := coreActivityUI(t)
				label, id := "tab/t2", "c"
				if path == "workspace" {
					label, id = "Other", "d"
				}
				release, held := holdCoreMethod(t, f, "terminal.attach "+id)
				switch activation {
				case "pointer":
					if path == "workspace" {
						terminalWorkspace(t, tt, label)
					} else {
						navigationRelease(t, tt, label)
					}
				case "enter":
					if path == "workspace" {
						focusNavigationControl(t, tt, "Terminals")
						tt.Key(0, ui.KeyEnter)
						if err := tt.ChooseMenuItem(label, "Open"); err != nil {
							t.Fatal(err)
						}
					} else {
						focusNavigationControl(t, tt, label)
						tt.KeyUnframed(0, ui.KeyEnter)
					}
				case "shortcut":
					tt.KeyUnframed(ui.Cmd, ui.Key2)
				}
				if !tt.TypeKeyNative(0, ui.KeyX, "x") {
					t.Fatal("first native character ineligible")
				}
				<-held
				tt.Key(0, ui.KeyBackspace)
				tt.Key(0, ui.KeyEnter)
				tt.SetClipboard("paste")
				tt.Key(ui.Super, ui.KeyV)
				noCoreData(t, f)
				release()
				readyCorePane(t, a, tt, id)
				wantCorePaneInput(t, f, id, "x\x7f\rpaste")
				tt.TypeKeyNative(0, ui.KeyY, "y")
				wantCorePaneInput(t, f, id, "y")
				noCoreData(t, f)
				noLegacyNavigation(t, f)
			})
		}
	}
}
func terminalInputFocused(tt *ui.Tester) bool {
	if tt.Focused("Panes") || tt.Focused("navigation-input") {
		return true
	}
	for _, label := range tt.Texts() {
		if strings.HasPrefix(label, "terminal/") && tt.Focused(label) {
			return true
		}
	}
	return false
}
