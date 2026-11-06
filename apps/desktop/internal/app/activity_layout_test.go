package app

import (
	"fmt"
	"github.com/egoist/mygo/ui"
	"os"
	"reflect"
	"testing"
	"vibest-desktop/internal/chrome"
)

func activityDescriptions(tt *ui.Tester) map[string]int {
	counts := map[string]int{}
	root := reflect.ValueOf(tt).Elem().FieldByName("rt").Elem().FieldByName("c").FieldByName("root")
	var walk func(reflect.Value)
	walk = func(p reflect.Value) {
		if p.IsNil() {
			return
		}
		n := p.Elem()
		if d := n.FieldByName("description").String(); d != "" {
			counts[d]++
		}
		for ch := n.FieldByName("first"); !ch.IsNil(); ch = ch.Elem().FieldByName("next") {
			walk(ch)
		}
	}
	walk(root)
	return counts
}

func repositoryCoreUI(t *testing.T) (*App, *coreAppFixture, *ui.Tester) {
	t.Helper()
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified VT library required")
	}
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		coreActivitySeed(f)
		f.layout.Workspaces[0].Repository = "fixture-repo"
		f.layout.Workspaces[1].Repository = "fixture-repo"
		f.layout.Workspaces[1].Linked = true
	})
	tt := ui.NewTester(a.View, 1280, 800)
	readyCorePane(t, a, tt, "a")
	return a, f, tt
}
func TestRepositoryDisclosureKeepsPaneInput(t *testing.T) {
	a, f, tt := repositoryCoreUI(t)
	a.mu.Lock()
	selection := a.coreSelection
	owner, _ := a.coreKeyboard.CaptureFor(a.coreViews["a"].Viewer)
	a.mu.Unlock()
	for _, label := range []string{"Collapse", "Expand"} {
		if err := tt.Click(label); err != nil {
			t.Fatal(err)
		}
		tt.Frame()
		if !tt.Focused("terminal/a") || a.returnFocus || !owner.Valid() {
			t.Fatalf("repository disclosure changed keyboard ownership: focus=%v return=%v capture=%v rect=%v owner=%+v", tt.Focused("terminal/a"), a.returnFocus, owner.Valid(), find(t, tt, "terminal/a"), a.coreKeyboard.OwnerKey())
		}
		coreAppAct(a, func() {
			if a.coreSelection.Pane != selection.Pane || a.coreSelection.Tab != selection.Tab {
				t.Fatal("disclosure navigated")
			}
		})
		wantCoreSeen(t, a, map[string]uint64{})
		noCoreClose(t, f)
		select {
		case p := <-f.inputs:
			t.Fatalf("disclosure produced DATA %q", p.body)
		default:
		}
		tt.TypeKey(0, ui.KeyX, "x")
		wantCoreInput(t, f, "x")
	}
}

func TestActivityApplicationThemes(t *testing.T) {
	for _, name := range chrome.Builtins {
		for _, scale := range []float32{1, 2} {
			t.Run(fmt.Sprintf("%s/%v", name, scale), func(t *testing.T) {
				a, f, tt := coreActivityUI(t)
				th, _ := chrome.Builtin(name)
				coreAppAct(a, func() { a.themes.light, a.themes.dark = th, th })
				reportActivity(t, a, f, "a", "working", 1, true)
				tt.SetSize(900, 650)
				tt.SetScale(scale)
				tt.SetDark(th.Dark)
				tt.Frame()
				counts := activityDescriptions(tt)
				if counts["Working (reported)"] != 2 || counts["Completed, not visited (reported)"] != 2 {
					t.Fatalf("scoped semantics: %v", counts)
				}
				repo := find(t, tt, "Repo")
				icon := find(t, tt, "activity: working")
				if icon.X <= repo.X+repo.W || icon.W != th.Slot || icon.H != th.Slot {
					t.Fatalf("activity layout: name=%v icon=%v", repo, icon)
				}
				px := tt.Image().RGBAAt(int((repo.X-10)*scale), int((repo.Y+repo.H/2)*scale))
				if !nearColor(px, th.Row.Active.Background) {
					t.Fatalf("leading slot has activity ink: %v", px)
				}
				if err := tt.Click("Repo"); err != nil {
					t.Fatal(err)
				}
				reportActivity(t, a, f, "a", "done", 1, true)
				tt.Move(-10, -10)
				tt.Frame()
				counts = activityDescriptions(tt)
				if counts["Working (reported)"] != 0 || counts["Completed, not visited (reported)"] != 1 {
					t.Fatalf("visited rows not empty: %v", counts)
				}
				f.peer.Close()
				awaitCoreApp(t, a, func() bool { return !a.connected })
				tt.Frame()
				absent(t, tt, "activity: working", "activity: done")
			})
		}
	}
}

func TestRepositoryDisclosureKeyboardActivity(t *testing.T) {
	for _, key := range []ui.Key{ui.KeyEnter, ui.KeySpace} {
		t.Run(fmt.Sprint(key), func(t *testing.T) {
			a, f, tt := repositoryCoreUI(t)
			focusNavigationControl(t, tt, "Repo")
			tt.Key(0, ui.KeyDown)
			if !tt.Focused("Collapse") {
				t.Fatal("disclosure not independently reachable")
			}
			tt.Key(0, key)
			tt.Frame()
			if !a.collapsed[a.machine.id()]["fixture-repo"] || !tt.Focused("Expand") {
				t.Fatal("keyboard disclosure navigated or lost focus")
			}
			wantCoreSeen(t, a, map[string]uint64{})
			noCoreClose(t, f)
			machineDisclosureState(t, tt, "Expand", false)
		})
	}
}
