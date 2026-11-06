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
				if counts["Working (reported)"] != 1 || counts["Completed, not visited (reported)"] != 1 {
					t.Fatalf("scoped semantics: %v", counts)
				}
				repo := find(t, tt, "Build")
				icon := find(t, tt, "activity: working")
				if icon.X <= repo.X+repo.W || icon.W != th.Slot || icon.H != th.Slot {
					t.Fatalf("activity layout: name=%v icon=%v", repo, icon)
				}
				coreAppAct(a, func() { a.SelectWorkspace("w1") })
				reportActivity(t, a, f, "a", "done", 1, true)
				tt.Move(-10, -10)
				tt.Frame()
				counts = activityDescriptions(tt)
				if counts["Working (reported)"] != 0 || counts["Completed, not visited (reported)"] != 0 {
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
