package app

import (
	"encoding/json"
	"fmt"
	"github.com/egoist/mygo/ui"
	"reflect"
	"testing"
	"vibest-desktop/internal/core"
)

func coreWorkspaceFixture(t *testing.T, scale float32, style, first, second string) (*App, *coreAppFixture, *ui.Tester) {
	a, f, tt := coreShellFixture(t, 1280, 800, scale, false, first, func(a *App) { a.themes.settings.PaneStyle = style })
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		ref := func(id string) *core.Split {
			f.terminals[id] = core.Terminal{Address: id, State: "live", Cols: 80, Rows: 24}
			return &core.Split{Pane: &core.Pane{ID: id, Terminal: core.TerminalRef{CoreID: f.layout.CoreID, Address: id}}}
		}
		root := ref("d")
		switch second {
		case "split":
			root = &core.Split{Axis: "x", Ratio: .62, First: root, Second: ref("e")}
		case "nested":
			root = &core.Split{Axis: "x", Ratio: .5, First: root, Second: &core.Split{Axis: "y", Ratio: .5, First: ref("e"), Second: ref("f")}}
		}
		f.layout.Workspaces[0].Label = "Alpha"
		f.layout.Workspaces = append(f.layout.Workspaces, core.Workspace{ID: "w2", Label: "Bravo", Tabs: []core.Tab{{ID: "t2", Root: root}}})
	})
	tt.Frame()
	return a, f, tt
}
func TestAWorkspaceSwitchIsSizedBeforeItShows(t *testing.T) {
	a, f, tt := coreWorkspaceFixture(t, 2, paneComfortable, "split", "single")
	before := corePaneGeometries(t, a, tt)
	release, held := holdCoreMethod(t, f, "terminal.attach d")
	terminalWorkspace(t, tt, "Bravo")
	if !tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("first workspace character lost")
	}
	tt.Frame()
	<-held
	if len(corePaneGeometries(t, a, tt)) != 0 {
		t.Fatal("old geometry presented as destination")
	}
	noCoreData(t, f)
	release()
	readyCorePane(t, a, tt, "d")
	wantCorePaneInput(t, f, "d", "x")
	after := corePaneGeometries(t, a, tt)
	if len(after) != 1 || after[0].card.W <= before[0].card.W {
		t.Fatal("destination did not use own geometry")
	}
	terminalWorkspace(t, tt, "Alpha")
	readyCorePane(t, a, tt, "a")
	if !reflect.DeepEqual(before, corePaneGeometries(t, a, tt)) {
		t.Fatal("return resized old tree incorrectly")
	}
	noLegacyNavigation(t, f)
}
func TestWorkspaceSwitchesAcrossChrome(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		for _, scale := range []float32{1, 2} {
			for _, pair := range [][2]string{{"split", "single"}, {"stack", "split"}, {"split", "nested"}, {"split", "split"}} {
				t.Run(fmt.Sprint(style, scale, pair), func(t *testing.T) {
					a, f, tt := coreWorkspaceFixture(t, scale, style, pair[0], pair[1])
					first := corePaneGeometries(t, a, tt)
					v := a.coreViews["a"]
					terminalWorkspace(t, tt, "Bravo")
					readyCorePane(t, a, tt, "d")
					for _, id := range []string{"e", "f"} {
						if _, ok := tt.Find("terminal/" + id); ok {
							awaitCorePaintWithoutOwnership(t, a, tt, id)
						}
					}
					second := corePaneGeometries(t, a, tt)
					for i := range 8 {
						row, id, want := "Alpha", "a", first
						if i%2 == 1 {
							row, id, want = "Bravo", "d", second
						}
						terminalWorkspace(t, tt, row)
						if !tt.TypeKeyNative(0, ui.KeyX, "x") {
							t.Fatal("switch lost first native character")
						}
						readyCorePane(t, a, tt, id)
						wantCorePaneInput(t, f, id, "x")
						if !reflect.DeepEqual(want, corePaneGeometries(t, a, tt)) {
							t.Fatal("workspace drawn on another tree's grid")
						}
						if a.coreViews["a"] != v {
							t.Fatal("ordinary switch replaced original VT")
						}
					}
					if len(coreRequests(f, "doc.set")) != 0 {
						t.Fatal("navigation mutated document")
					}
					noCoreData(t, f)
				})
			}
		}
	}
}
func TestRapidWorkspaceSwitchesSettleOnTheLast(t *testing.T) {
	a, f, tt := coreWorkspaceFixture(t, 2, paneComfortable, "split", "single")
	release, held := holdCoreMethod(t, f, "terminal.attach d")
	terminalWorkspace(t, tt, "Bravo")
	tt.Type("lost")
	tt.Frame()
	<-held
	terminalWorkspace(t, tt, "Alpha")
	tt.Type("fresh")
	readyCorePane(t, a, tt, "a")
	wantCorePaneInput(t, f, "a", "fresh")
	release()
	awaitCoreApp(t, a, func() bool { return a.coreViews["d"] != nil })
	coreOutput(t, a, f, tt, "d", "late background VT")
	if a.coreSelection.Pane != "a" {
		t.Fatal("late output retargeted navigation")
	}
	tt.Type("later")
	wantCorePaneInput(t, f, "a", "later")
	noCoreData(t, f)
}
func TestARefusedSwitchTakesTheGridBack(t *testing.T) {
	a, f, tt := coreWorkspaceFixture(t, 1, paneComfortable, "split", "single")
	v := a.coreViews["a"]
	coreAppAct(a, func() { a.SelectWorkspace("absent") })
	tt.Frame()
	if a.navigationNote == "" || !a.corePending || a.coreViews["a"] != v || a.coreSelection.Workspace != "w1" {
		t.Fatal("invalid local destination changed old model/ownership")
	}
	tt.Type("refused")
	noCoreData(t, f)
	terminalWorkspace(t, tt, "Alpha")
	tt.Type("fresh")
	readyCorePane(t, a, tt, "a")
	wantCorePaneInput(t, f, "a", "fresh")
	noLegacyNavigation(t, f)
}
func TestLayoutsKnownFollowTheSession(t *testing.T) {
	a, f, tt := coreWorkspaceFixture(t, 1, paneComfortable, "split", "single")
	terminalWorkspace(t, tt, "Bravo")
	readyCorePane(t, a, tt, "d")
	old := a.coreViews["a"]
	publishCoreLayout(t, a, f, func(f *coreAppFixture) { f.layout.Workspaces = f.layout.Workspaces[1:] })
	awaitCoreApp(t, a, func() bool { return a.coreViews["a"] == nil })
	if a.coreState.Layout.Tab("t") != nil {
		t.Fatal("removed layout retained")
	}
	capture, ok := a.coreKeyboard.CaptureFor(a.coreViews["d"].Viewer)
	if !ok {
		t.Fatal("no valid capture")
	}
	layout, _ := json.Marshal(a.coreState.Layout)
	next := reconnectCoreApp(t, a, f, func(n *coreAppFixture) {
		json.Unmarshal(layout, &n.layout)
		n.terminals["d"] = core.Terminal{Address: "d", State: "live", Cols: 80, Rows: 24}
	})
	readyCorePane(t, a, tt, "d")
	if _, err := capture.Write([]byte("stale")); err == nil {
		t.Fatal("session retained old input capture")
	}
	if a.coreViews["d"] == old {
		t.Fatal("session reused renderer")
	}
	tt.Type("new")
	wantCorePaneInput(t, next, "d", "new")
	noCoreData(t, f)
	noCoreData(t, next)
}
