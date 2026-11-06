package app

import (
	"github.com/egoist/mygo/ui"
	"reflect"
	"strings"
	"testing"
)

func TestASplitShowsAtOnceClippedUntilItsAnswer(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
	release, held := holdCoreMethod(t, f, "terminal.run")
	tt.Key(ui.Cmd, ui.KeyD)
	if !tt.TypeKeyNative(0, ui.Key1, "1") {
		t.Fatal("split first input lost")
	}
	<-held
	noCoreData(t, f)
	releaseAttach, attach := holdCoreMethod(t, f, "terminal.attach t5")
	release()
	awaitCoreApp(t, a, func() bool { return !a.corePending && a.coreState.Version == 1 })
	tt.Frame()
	<-attach
	tt.Type("2")
	noCoreData(t, f)
	releaseAttach()
	readyCorePane(t, a, tt, a.coreSelection.Pane)
	wantCorePaneInput(t, f, "t5", "12")
	tt.Type("3")
	wantCorePaneInput(t, f, "t5", "3")
	if len(corePaneGeometries(t, a, tt)) != 2 {
		t.Fatal("new split geometry missing")
	}
	noCoreData(t, f)
}
func TestPendingEndsWithHerdrsAnswer(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
	v := a.coreViews["a"]
	before := corePaneGeometries(t, a, tt)[0]
	tt.SetSize(1200, 760)
	tt.Frame()
	after := corePaneGeometries(t, a, tt)[0]
	if before.cols == after.cols && before.rows == after.rows {
		t.Fatal("resize did not reflow real VT")
	}
	for range 5 {
		coreOutput(t, a, f, tt, "a", "idle output\r\n")
		tt.Type("k")
		wantCorePaneInput(t, f, "a", "k")
	}
	if a.coreViews["a"] != v {
		t.Fatal("resize replaced renderer")
	}
	noCoreData(t, f)
}
func TestCloseAndZoomShowAtOnce(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "nested")
	old := a.coreViews["c"]
	coreAppAct(a, func() { a.zoomPane("b") })
	readyCorePane(t, a, tt, "b")
	if len(corePaneGeometries(t, a, tt)) != 1 {
		t.Fatal("zoom not shown immediately")
	}
	tt.Type("b")
	wantCorePaneInput(t, f, "b", "b")
	coreAppAct(a, func() { a.zoomPane("b") })
	tt.Frame()
	if len(corePaneGeometries(t, a, tt)) != 3 {
		t.Fatal("unzoom missing siblings")
	}
	coreAppAct(a, func() { a.ClosePane("c") })
	tt.Frame()
	if err := tt.Click("Close"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return a.coreViews["c"] == nil })
	tt.Frame()
	old.VT.Paste("closed")
	noCoreData(t, f)
	absent(t, tt, "terminal/c")
}
func TestATabSwitchShowsTheNewTabAtOnce(t *testing.T) {
	a, f, tt, release, target := delayedCoreDestination(t, "attach")
	find(t, tt, "pane/c")
	absent(t, tt, "pane/a", "pane/b")
	tt.TypeKeyNative(0, ui.KeyX, "x")
	select {
	case p := <-f.inputs:
		t.Fatalf("unpainted destination sent %q", p.body)
	default:
	}
	release()
	id := target()
	readyCorePane(t, a, tt, id)
	first := wantCoreInput(t, f, "x")
	tt.Type("destination")
	channel := wantCoreInput(t, f, "destination")
	f.mu.Lock()
	want := f.channels["c"]
	f.mu.Unlock()
	if first != want || channel != want {
		t.Fatal("tab switch retargeted input")
	}
	wantCoreViewerControls(t, f, channel)
}
func TestAFirstFrameThatDoesNotFitIsNotKept(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	tt.SetSize(500, 60)
	navigationRelease(t, tt, "tab/t2")
	if !tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("bounded navigation sink lost first input")
	}
	awaitCoreApp(t, a, func() bool { return a.coreViews["c"] != nil })
	tt.Frame()
	v := a.coreViews["c"]
	if v.InputReady() {
		t.Fatal("clipped first frame granted ownership")
	}
	noCoreData(t, f)
	tt.SetSize(1280, 800)
	tt.Frame()
	readyCorePane(t, a, tt, "c")
	wantCorePaneInput(t, f, "c", "x")
	if a.coreCapture != nil {
		t.Fatal("ready helper did not release bounded capture")
	}
	tt.Type("fresh")
	wantCorePaneInput(t, f, "c", "fresh")
	noCoreData(t, f)
}
func TestAPopupTakesItsOwnInput(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	v := a.coreViews["a"]
	coreAppAct(a, func() { a.askInWindow("Popup", "", false, func(string) {}) })
	tt.Frame()
	tt.TypeKeyNative(0, ui.KeyX, "x")
	if a.dialog.value != "x" || !tt.Focused("Popup") {
		t.Fatal("modal lost keyboard")
	}
	noCoreData(t, f)
	tt.Key(0, ui.KeyEscape)
	tt.Type("later")
	wantCorePaneInput(t, f, "a", "later")
	if a.coreViews["a"] != v {
		t.Fatal("modal replaced VT")
	}
}
func TestTooSmallRecovers(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
	v := a.coreViews["a"]
	for _, h := range []int{50, 20, 0} {
		tt.SetSize(400, h)
		tt.Frame()
		if v.InputReady() {
			t.Fatal("too-small view kept input")
		}
		tt.TypeKeyNative(0, ui.KeyX, "x")
		v.VT.Paste("no")
		noCoreData(t, f)
	}
	tt.SetSize(1280, 800)
	readyCorePane(t, a, tt, "a")
	tt.Type("yes")
	wantCorePaneInput(t, f, "a", "yes")
	if a.coreViews["a"] != v {
		t.Fatal("resize lost renderer")
	}
}
func TestUnfocusedPanesTakeTheirInputWithoutBorders(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "split", func(a *App) { a.themes.settings.PaneStyle = style })
		r := find(t, tt, "terminal/b")
		tt.ClickAt(r.X+20, r.Y+20)
		readyCorePane(t, a, tt, "b")
		tt.Type("b")
		wantCorePaneInput(t, f, "b", "b")
		r = find(t, tt, "terminal/a")
		tt.ClickAt(r.X+20, r.Y+20)
		readyCorePane(t, a, tt, "a")
		tt.Type("a")
		wantCorePaneInput(t, f, "a", "a")
		noCoreData(t, f)
	}
}
func TestContinuousResizeKeepsKeysAndClips(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "nested")
	v := coreOutput(t, a, f, tt, "a", "populated output")
	for i := range 16 {
		tt.SetSize(1280-i*12, 800-i*8)
		tt.Frame()
		tt.TypeKeyNative(0, ui.KeyX, "x")
		wantCorePaneInput(t, f, "a", "x")
		for _, pl := range corePaneGeometries(t, a, tt) {
			origin := find(t, tt, "Panes")
			if pl.term.X < 0 || pl.term.Y < 0 || pl.term.X+pl.term.W > origin.W+1 || pl.term.Y+pl.term.H > origin.H+1 {
				t.Fatal("resized VT escaped viewport")
			}
		}
	}
	if a.coreViews["a"] != v || !strings.Contains(v.VT.Text(), "populated output") {
		t.Fatal("continuous resize lost VT/history")
	}
	noCoreData(t, f)
}
func TestFontSizeChangeKeepsKeys(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
	v := a.coreViews["a"]
	before := corePaneGeometries(t, a, tt)[0]
	for _, size := range []float32{17, 10, 13} {
		coreAppAct(a, func() { a.fontSize = size })
		tt.Frame()
		tt.TypeKeyNative(0, ui.KeyX, "x")
		wantCorePaneInput(t, f, "a", "x")
		if a.coreViews["a"] != v {
			t.Fatal("font replaced VT")
		}
	}
	if !reflect.DeepEqual(before, corePaneGeometries(t, a, tt)[0]) {
		t.Fatal("font roundtrip changed geometry")
	}
}
func TestAStaleSurfaceKeepsKeysWhileIdle(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	coreAppAct(a, func() { a.ShowPane("c") })
	readyCorePane(t, a, tt, "c")
	for range 5 {
		coreOutput(t, a, f, tt, "a", "background old tab output")
		tt.Type("x")
		wantCorePaneInput(t, f, "c", "x")
	}
	noCoreData(t, f)
}
func TestPopupKeysFollowTheLatestSurface(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	coreAppAct(a, func() { a.askInWindow("Old popup", "", false, func(string) { t.Error("stale modal submitted") }) })
	tt.Frame()
	old := a.dialog
	coreAppAct(a, func() { a.askInWindow("New popup", "", false, func(string) {}) })
	tt.Frame()
	tt.TypeKeyNative(0, ui.KeyX, "x")
	if old.value != "" || a.dialog.value != "x" || !tt.Focused("New popup") {
		t.Fatal("text crossed replacement modal identity")
	}
	noCoreData(t, f)
	tt.Key(0, ui.KeyEscape)
	tt.Type("later")
	wantCorePaneInput(t, f, "a", "later")
}
func TestAMachineSwitchKeepsKeys(t *testing.T) {
	a, f, tt := coreMachineUI(t)
	terminalWorkspace(t, tt, "Remote Alpha")
	wantRemoteNavigation(t, a, f, tt, "d")
	terminalWorkspace(t, tt, "Repo")
	tt.TypeKeyNative(0, ui.KeyX, "x")
	readyCorePane(t, a, tt, "a")
	wantCorePaneInput(t, f, "a", "x")
	coreOutput(t, a, f, tt, "d", "late remote report")
	tt.Type("later")
	wantCorePaneInput(t, f, "a", "later")
	noCoreData(t, f)
}
