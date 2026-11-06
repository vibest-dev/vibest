package app

import (
	"strings"
	"testing"

	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"

	"github.com/egoist/mygo/ui"
)

func TestPaneCardTargetsTheClickedPane(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "split")
	coreAppAct(a, func() { a.RenamePane("a", "alpha") })
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("a").Label == "alpha" })
	tt.Frame()
	find(t, tt, "alpha")
	find(t, tt, "b")
	find(t, tt, "Repo")
	for _, text := range tt.Texts() {
		if strings.HasPrefix(text, "status:") {
			t.Fatal("redundant activity dot")
		}
	}
	if err := tt.Click("split-right/b"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return !a.corePending && a.coreState.Version == 2 })
	root := a.coreState.Layout.Tab("t").Root
	if root.First.Pane.ID != "a" || root.Second.First.Pane.ID != "b" {
		t.Fatal("clicked split targeted wrong pane")
	}
	readyCorePane(t, a, tt, a.coreSelection.Pane)
	if err := tt.Click("zoom/b"); err != nil {
		t.Fatal(err)
	}
	if a.coreSelection.Zoom != "b" {
		t.Fatal("clicked zoom targeted wrong pane")
	}
	readyCorePane(t, a, tt, "b")
	if err := tt.Click("close-pane/b"); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("Close"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("b") == nil })
	if a.coreState.Layout.Tab("t") == nil || len(coreRequests(f, "terminal.kill")) != 1 {
		t.Fatal("pane close also closed tab")
	}
	noLegacyNavigation(t, f)
	noCoreData(t, f)
}

func TestNarrowCardKeepsCloseOffTheSplits(t *testing.T) {
	_, _, tt := coreShellFixture(t, 1280, 800, 1, false, "split")
	tt.SetSize(420, 600)
	tt.Frame()
	b := find(t, tt, "close-pane/b")
	pane := find(t, tt, "pane/b")
	if b.W < 12 || b.H < 12 || b.X < pane.X || b.X+b.W > pane.X+pane.W+.1 {
		t.Fatal("narrow close missing or outside card", b, pane)
	}
	for _, name := range []string{"split-right/b", "split-down/b", "zoom/b"} {
		if r, ok := tt.Find(name); ok && rectsOverlap(r, b) {
			t.Fatal("close overlaps", name)
		}
	}
}

func rectsOverlap(a, b ui.Rect) bool {
	return a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H
}

func TestCardStrokeFollowsFocus(t *testing.T) {
	a, _, tt := coreShellFixture(t, 1280, 800, 1, false, "split", func(a *App) { a.themes.settings.FollowSystem = false })
	coreAppAct(a, func() { a.RenamePane("a", "alpha") })
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("a").Label == "alpha" })
	tt.Frame()
	img := tt.Image()
	origin := find(t, tt, "Panes")
	for _, pl := range corePaneGeometries(t, a, tt) {
		for _, dx := range []float32{0, 1, pl.card.W - 1} {
			if nearColor(img.RGBAAt(int(origin.X+pl.card.X+dx), int(origin.Y+pl.card.Y+headH/2)), chrome.Light.Accent) {
				t.Fatal("pane draws accent outline")
			}
		}
	}
	title := find(t, tt, "alpha")
	found := false
	for y := int(title.Y); y < int(title.Y+title.H); y++ {
		for x := int(title.X); x < int(title.X+title.W); x++ {
			found = found || nearColor(img.RGBAAt(x, y), chrome.Light.Accent)
		}
	}
	if !found {
		t.Fatal("focused title lacks accent")
	}
}

func TestClosingTheOnlyPaneDoesNotCloseTheTab(t *testing.T) {
	a, f, tt := coreShellFixture(t, 900, 600, 1, false, "single")
	if err := tt.Click("close-pane/a"); err != nil {
		t.Fatal(err)
	}
	if a.dialog == nil || len(coreRequests(f, "terminal.kill")) != 0 {
		t.Fatal("close bypassed confirmation")
	}
	if err := tt.Click("Close"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return !a.corePending && a.coreState.Layout.Pane("a") == nil })
	if len(coreRequests(f, "terminal.kill")) != 1 || len(coreRequests(f, "doc.set")) != 1 {
		t.Fatal("pane close dispatched additional mutation")
	}
	noLegacyNavigation(t, f)
}

func TestTabBarDividerIsTheGridLine(t *testing.T) {
	a, _, tt := coreShellFixture(t, 1280, 800, 1, false, "split")
	bar, panes, win, gap, tab := find(t, tt, "tab-bar"), find(t, tt, "Panes"), find(t, tt, "window-chrome"), find(t, tt, "pane-gap"), find(t, tt, "tab/t")
	if !nearDip(bar.Y, win.Y) || !nearDip(bar.Y+bar.H, win.Y+win.H) || panes.Y < tab.Y+tab.H || !near1(panes.Y-tab.Y-tab.H, outerPad, .5) {
		t.Fatal("header/tab/gap geometry", bar, panes, win, gap, tab)
	}
	img := tt.Image()
	if got := img.RGBAAt(int(gap.X+gap.W/2), int(gap.Y+gap.H/2)); !nearColor(got, chrome.Light.Background) {
		t.Fatal("tab gap not window background", got)
	}
	pl := corePaneGeometries(t, a, tt)[0]
	if nearColor(img.RGBAAt(int(panes.X+pl.card.X+cardRadius(1)+8), int(panes.Y+pl.card.Y)), chrome.Light.Accent) {
		t.Fatal("pane stroke is accent")
	}
}

func TestStalePaneHasNoButton(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "split")
	coreAppAct(a, func() { a.coreEdit(func(l *core.Layout) error { return l.RemovePane("b") }) })
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("b") == nil })
	tt.Frame()
	absent(t, tt, "close-pane/b", "split-right/b")
	if err := tt.Click("close-pane/a"); err != nil {
		t.Fatal(err)
	}
	if a.dialog == nil {
		t.Fatal("remaining pane cannot close")
	}
	noCoreData(t, f)
}

func TestSplitNamesThePaneWithoutFocusingFirst(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "split")
	original := a.coreSelection
	coreAppAct(a, func() { a.Split("gone", "right") })
	if a.err == "" || a.coreSelection.Pane != original.Pane || len(coreRequests(f, "terminal.run")) != 0 {
		t.Fatal("missing pane split retargeted or silently failed")
	}
	tt.Type("x")
	wantCorePaneInput(t, f, "a", "x")
	noLegacyNavigation(t, f)
}

func TestPaneMatchesTheTerminalAndKeepsAnExplicitColor(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1000, 700, 1, false, "single")
	v := coreOutput(t, a, f, tt, "a", "\x1b[Hxxxx\x1b[48;2;200;10;10m \x1b[0m")
	for _, name := range []string{"Paper", "Newsprint", "Nord"} {
		th, _ := chrome.Builtin(name)
		coreAppAct(a, func() { a.themes.light = th; a.themes.settings.FollowSystem = false })
		tt.Frame()
		pane := find(t, tt, "Panes")
		if got := tt.Image().RGBAAt(int(pane.X+cardRadius(1)+8), int(pane.Y+2)); !nearColor(got, th.Terminal.Background) {
			t.Fatal("pane surround not theme background", got)
		}
		cell := vtCell(t, tt, v, "a", 4, 0)
		if got := tt.Image().RGBAAt((cell.Min.X+cell.Max.X)/2, (cell.Min.Y+cell.Max.Y)/2); !nearColor(got, ui.RGB(200, 10, 10)) {
			t.Fatal("explicit RGB changed with theme", got)
		}
	}
}

func TestPaneGridFillsTheContainer(t *testing.T) {
	for _, scale := range []float32{1, 1.25, 1.5, 2} {
		a, f, tt := coreShellFixture(t, 1280, 800, scale, false, "nested")
		box, panes := find(t, tt, "pane-container"), find(t, tt, "Panes")
		if box != panes {
			t.Fatal("container has extra gutter", box, panes)
		}
		ps := corePaneGeometries(t, a, tt)
		for _, pl := range ps {
			right := pl.card.X + pl.card.W - pl.term.X - pl.term.W - sidePad(scale)
			below := pl.card.Y + pl.card.H - pl.term.Y - pl.term.H - bottomPad(scale)
			if right < -.5/scale-.01 || right >= pl.cw+.5/scale+.01 || below < -.5/scale-.01 || below >= pl.ch+.5/scale+.01 {
				t.Fatal("whole cells do not fill reserves", pl)
			}
		}
		vx := int((panes.X + ps[0].card.W + cardGap(scale)/2) * scale)
		hy := int((panes.Y + ps[2].card.Y - cardGap(scale)/2) * scale)
		if got := tt.Image().RGBAAt(vx, int((panes.Y+panes.H)*scale)-1); !nearColor(got, chrome.Light.Background) {
			t.Fatal("vertical gap misses bottom", got)
		}
		if got := tt.Image().RGBAAt(int((panes.X+panes.W)*scale)-1, hy); !nearColor(got, chrome.Light.Background) {
			t.Fatal("horizontal gap misses right", got)
		}
		coreAppAct(a, func() { a.ShowPane("b") })
		readyCorePane(t, a, tt, "b")
		coreOutput(t, a, f, tt, "b", "\x1b[2;2H")
		caret, ok := tt.TextCaret()
		b := ps[1]
		if !ok || !near1(caret.X, panes.X+b.term.X+b.cw, .5) || !near1(caret.Y, panes.Y+b.term.Y+b.ch, .5) {
			t.Fatal("caret wrong origin", caret)
		}
		r := find(t, tt, "terminal/c")
		tt.ClickAt(r.X+20, r.Y+20)
		readyCorePane(t, a, tt, "c")
		tt.Type("x")
		wantCorePaneInput(t, f, "c", "x")
	}
}

func TestHiddenTerminalTakesNoInput(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	coreAppAct(a, func() {
		a.coreEdit(func(l *core.Layout) error { l.Tab("t1").Root.Axis = "y"; l.Tab("t1").Root.Ratio = .05; return nil })
	})
	awaitCoreApp(t, a, func() bool { return a.coreState.Version == 1 })
	tt.Frame()
	tt.Frame()
	a.mu.Lock()
	v := a.coreViews["a"]
	a.mu.Unlock()
	if v.InputReady() {
		t.Fatal("less than one terminal row retained input")
	}
	tt.TypeKeyNative(0, ui.KeyX, "x")
	tt.SetClipboard("pasted")
	tt.Key(ui.Cmd, ui.KeyV)
	select {
	case p := <-f.inputs:
		t.Fatalf("hidden terminal sent %q", p.body)
	default:
	}
	if _, active := tt.TextCaret(); active {
		t.Fatal("hidden terminal kept native composition eligibility")
	}
	r := find(t, tt, "terminal/b")
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	readyCorePane(t, a, tt, "b")
	tt.Type("visible sibling")
	channel := wantCoreInput(t, f, "visible sibling")
	f.mu.Lock()
	want := f.channels["b"]
	f.mu.Unlock()
	if channel != want {
		t.Fatal("visible sibling retargeted")
	}
}
