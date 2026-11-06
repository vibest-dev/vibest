package app

import (
	"strings"
	"testing"

	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/herdr"

	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

func framedPair() *herdr.Surface {
	const w, h = 40, 20
	cells := make([]herdr.Cell, w*h)
	for i := range cells {
		cells[i] = herdr.Cell{Symbol: "x", Link: -1}
	}
	return &herdr.Surface{
		Frame: herdr.Frame{W: w, H: h, Cells: cells, Cursor: &herdr.Cursor{X: 2, Y: 2, Visible: true}},
		Panes: []herdr.SurfacePane{
			{ID: "a", Focused: true, Rect: herdr.Rect{Width: 20, Height: h}, Inner: herdr.Rect{X: 1, Y: 1, Width: 17, Height: h - 2}},
			{ID: "b", Rect: herdr.Rect{X: 20, Width: 20, Height: h}, Inner: herdr.Rect{X: 21, Y: 1, Width: 17, Height: h - 2}},
		},
		Splits: []herdr.SurfaceSplit{{Across: true, Pos: 20, Area: herdr.Rect{Width: w, Height: h}, Hit: herdr.Rect{X: 19, Width: 2, Height: h}, Path: []bool{}}},
	}
}

func TestPanePlacesKeepTheTerminalIntact(t *testing.T) {
	s := framedPair()
	const cw, ch, scale float32 = 9, 18, 2
	v := frameAt(s, 400, 400, cw, ch, scale)
	ps := v.places
	if len(ps) != 2 || len(v.lines) != 1 {
		t.Fatalf("panes %d lines %d", len(ps), len(v.lines))
	}
	if l := v.lines[0].r; !nearDip(ps[0].card.X+ps[0].card.W, l.X) || !nearDip(l.X+l.W, ps[1].card.X) {
		t.Fatalf("a %v line %v b %v", ps[0].card, l, ps[1].card)
	}
	for _, pl := range ps {
		if pl.head.H != headH || pl.term.Y != pl.card.Y+headH || pl.term.X != pl.card.X+sidePad(scale) {
			t.Fatalf("header or terminal off its card: %+v", pl)
		}
		if pl.term.Y+pl.term.H > pl.card.Y+pl.card.H+0.1 {
			t.Fatalf("terminal leaves the card: %+v", pl)
		}
		if pl.term.W != float32(pl.pane.Inner.Width)*cw || pl.term.H != float32(pl.pane.Inner.Height)*ch {
			t.Fatalf("term %v is not the inner grid", pl.term)
		}
	}
	if ps[0].card.X != 0 || ps[0].card.Y != 0 {
		t.Fatalf("outer card %v, want the element's origin", ps[0].card)
	}
}

func TestLonePaneReservesAHeaderAndShowsTheLastRow(t *testing.T) {
	s := &herdr.Surface{Frame: herdr.Frame{W: 80, H: 30}, Panes: []herdr.SurfacePane{
		{ID: "a", Rect: herdr.Rect{Width: 80, Height: 30}, Inner: herdr.Rect{Width: 79, Height: 30}},
	}}
	const scale float32 = 1.5
	g := &grid{shell: metricsFor(1)}
	g.layout(terminal.Options{}, 13, ui.Rect{W: 640, H: 480}, scale, s)
	if g.rows < 1 || float32(g.rows)*g.ch > 480-28-termBottom+0.01 || float32(g.cols)*g.cw > 640-12+0.01 {
		t.Fatalf("grid %dx%d of %vx%v does not fit 628x450", g.cols, g.rows, g.cw, g.ch)
	}
	fit := &herdr.Surface{Frame: herdr.Frame{W: g.cols, H: g.rows}, Panes: []herdr.SurfacePane{{
		ID: "a", Rect: herdr.Rect{Width: g.cols, Height: g.rows}, Inner: herdr.Rect{Width: g.cols - 1, Height: g.rows},
	}}}
	v := frameAt(fit, 640, 480, g.cw, g.ch, g.scale)
	if len(v.places) != 1 || !v.fits {
		t.Fatalf("lone frame %+v", v)
	}
	pl := v.places[0]
	if pl.term.X != 6 || pl.term.Y != 28 || pl.head.H != 28 {
		t.Fatalf("lone header/term %+v", pl)
	}
	if pl.term.Y+pl.term.H > 480-termBottom+0.1 {
		t.Fatalf("lone terminal past the card %+v", pl.term)
	}
}

func TestBorderlessSplitsGetHeaders(t *testing.T) {
	v := twoPanes()
	if len(v.places) != 2 || !v.fits {
		t.Fatalf("places %d fits %v", len(v.places), v.fits)
	}
	for _, pl := range v.places {
		if pl.head.H != headH || pl.term.Y != headH || len(headButtons(pl)) == 0 {
			t.Fatalf("%s: header %v term %v buttons %v", pl.pane.ID, pl.head, pl.term, headButtons(pl))
		}
	}
}

func TestHeaderDoesNotSelectOrDrag(t *testing.T) {
	s := framedPair()
	v := frameAt(s, 400, 400, 10, 20, 1)
	v.pane, v.tab = "a", "t"
	ps := frameAt(s, v.w, v.h, v.cw, v.ch, v.scale).places
	x, y := ps[1].head.X+4, ps[1].head.Y+4
	var in interaction
	ok, fx := in.handle(ui.InputEvent{Kind: ui.InputPointerDown, X: x, Y: y}, v)
	if !ok || in.drag != nil || in.sel != nil {
		t.Fatalf("header down ok %v drag %v sel %v fx %#v", ok, in.drag != nil, in.sel != nil, fx)
	}
	focused := false
	for _, f := range fx {
		if _, yes := f.(focusPane); yes {
			focused = true
		}
	}
	if !focused {
		t.Fatalf("header click did not focus the pane: %#v", fx)
	}
}

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

func narrowPair() *herdr.Surface {
	const w, h = 16, 12
	cells := make([]herdr.Cell, w*h)
	for i := range cells {
		cells[i] = herdr.Cell{Symbol: "x", Link: -1}
	}
	return &herdr.Surface{
		Frame: herdr.Frame{W: w, H: h, Cells: cells},
		Panes: []herdr.SurfacePane{
			{ID: "a", Focused: true, Rect: herdr.Rect{Width: 8, Height: h}, Inner: herdr.Rect{X: 1, Y: 1, Width: 5, Height: h - 2}},
			{ID: "b", Rect: herdr.Rect{X: 8, Width: 8, Height: h}, Inner: herdr.Rect{X: 9, Y: 1, Width: 5, Height: h - 2}},
		},
	}
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

func TestThreePanesKeepGapsAndTheLastRow(t *testing.T) {
	s := herdrAnswer(30, 18, "nested")
	ps := frameAt(s, 300, 360, 10, 20, 2).places
	if len(ps) != 3 {
		t.Fatalf("places %d", len(ps))
	}
	side := ps[1].card.X - (ps[0].card.X + ps[0].card.W)
	under := ps[2].card.Y - (ps[1].card.Y + ps[1].card.H)
	if !nearDip(side, cardGap(2)) || !nearDip(under, cardGap(2)) {
		t.Fatalf("between side %v stack %v, want the card gap", side, under)
	}
	for _, pl := range ps {
		if pl.head.H <= 0 || pl.head.Y+pl.head.H > pl.term.Y+0.1 || pl.term.Y+pl.term.H > pl.card.Y+pl.card.H+0.1 {
			t.Fatalf("pane %s header/term %+v %+v", pl.pane.ID, pl.head, pl.term)
		}
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

func TestReportedGridDoesNotShrinkFromInner(t *testing.T) {
	const cw, ch float32 = 8, 16
	tiny := herdrAnswer(10, 4, "single")
	cols, rows := paneGrid(tiny, 800, 600, cw, ch, 2)
	if cols != 98 || rows != 35 {
		t.Fatalf("report %dx%d followed the tiny inner", cols, rows)
	}
	for _, mode := range []string{"single", "split", "stack", "nested", "zoom"} {
		for _, scale := range []float32{1, 1.5, 2} {
			c, r := paneGrid(herdrAnswer(40, 20, mode), 900, 700, cw, ch, scale)
			s := herdrAnswer(c, r, mode)
			c2, r2 := paneGrid(s, 900, 700, cw, ch, scale)
			v := frameAt(s, 900, 700, cw, ch, scale)
			if c2 != c || r2 != r || !v.fits {
				t.Fatalf("%s at %v: %dx%d then %dx%d, fits %v", mode, scale, c, r, c2, r2, v.fits)
			}
			for _, pl := range v.places {
				if pl.term.W != float32(pl.pane.Inner.Width)*cw || pl.term.H != float32(pl.pane.Inner.Height)*ch {
					t.Fatalf("%s clipped or stretched term %v inner %v", mode, pl.term, pl.pane.Inner)
				}
				if !v.showsPane(pl.pane.ID) {
					t.Fatalf("%s: %s not shown, term %v", mode, pl.pane.ID, pl.term)
				}
			}
		}
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

func TestRequestFollowsTheWindowNotTheInner(t *testing.T) {
	const cw, ch float32 = 8, 16
	lone := herdrAnswer(40, 10, "single")
	cols, rows := paneGrid(lone, 800, 600, cw, ch, 2)
	if cols < 10 || rows < 10 {
		t.Fatalf("grown %dx%d", cols, rows)
	}
	for _, scale := range []float32{1, 1.25, 1.5, 2} {
		cols, rows = paneGrid(lone, 2*sidePad(scale)+4*cw+0.4, headH+bottomPad(scale)+2*ch+0.2, cw, ch, scale)
		if cols != 4 || rows != 2 {
			t.Fatalf("scale %v reports %dx%d, want 4x2 full cells", scale, cols, rows)
		}
	}
}

func TestInnerDecidesWhatIsShown(t *testing.T) {
	const cw, ch float32 = 8, 16
	show := func(p herdr.SurfacePane, elemW, elemH float32) bool {
		term := ui.Rect{X: 0, Y: 0, W: float32(p.Inner.Width) * cw, H: float32(p.Inner.Height) * ch}
		return paneShowsTerminal(p, term, elemW, elemH, false)
	}
	in := func(x, y, w, h int) herdr.Rect { return herdr.Rect{X: x, Y: y, Width: w, Height: h} }
	if !show(herdr.SurfacePane{ID: "a", Rect: in(0, 0, 6, 4), Inner: in(1, 1, 4, 2)}, 1000, 1000) {
		t.Fatal("framed 6x4 should show")
	}
	if show(herdr.SurfacePane{ID: "a", Rect: in(0, 0, 4, 2), Inner: in(1, 1, 2, 0)}, 1000, 1000) {
		t.Fatal("framed 4x2 inner is not a terminal")
	}
	if show(herdr.SurfacePane{ID: "a", Rect: in(0, 0, 4, 4), Inner: in(1, 1, 2, 2)}, 1000, 1000) ||
		show(herdr.SurfacePane{ID: "b", Rect: in(4, 0, 4, 4), Inner: in(5, 1, 2, 2)}, 1000, 1000) {
		t.Fatal("8-wide split should hide both panes")
	}
	wide := herdr.SurfacePane{ID: "a", Rect: in(0, 0, 6, 4), Inner: in(1, 1, 4, 2)}
	narrow := herdr.SurfacePane{ID: "b", Rect: in(6, 0, 5, 4), Inner: in(7, 1, 3, 2)}
	if !show(wide, 1000, 1000) || show(narrow, 1000, 1000) {
		t.Fatal("11-wide split: 6-wide pane shows, 5-wide pane does not")
	}
	if !show(herdr.SurfacePane{ID: "a", Rect: in(0, 0, 6, 4), Inner: in(1, 1, 4, 2)}, 1000, 1000) ||
		!show(herdr.SurfacePane{ID: "b", Rect: in(6, 0, 6, 4), Inner: in(7, 1, 4, 2)}, 1000, 1000) {
		t.Fatal("12-wide split should show both")
	}
	if !show(herdr.SurfacePane{ID: "a", Rect: in(0, 0, 4, 2), Inner: in(0, 0, 4, 2)}, 1000, 1000) {
		t.Fatal("unframed 4 should show")
	}
	if !show(herdr.SurfacePane{ID: "a", Rect: in(0, 0, 5, 2), Inner: in(0, 0, 4, 2)}, 1000, 1000) {
		t.Fatal("unframed 5 with the gutter already removed should show")
	}
	if show(herdr.SurfacePane{ID: "a", Rect: in(0, 0, 3, 2), Inner: in(0, 0, 3, 2)}, 1000, 1000) {
		t.Fatal("unframed 3 is under the terminal minimum")
	}
	if show(herdr.SurfacePane{ID: "a", Rect: in(0, 0, 6, 4), Inner: in(1, 1, 4, 2)}, float32(4)*cw, float32(2)*ch-1.5) {
		t.Fatal("a fraction short of the inner was treated as fitting")
	}
}

func TestLayoutKeepsTheLastFitWhenThePaneIsTooShort(t *testing.T) {
	g := grid{shell: metricsFor(1)}
	s := herdrAnswer(80, 24, "single")
	fit := ui.Rect{W: 800, H: 600}
	g.layout(terminal.Options{}, 13, fit, 2, s)
	if g.tooSmall || g.rows < 2 || g.cols < 2 {
		t.Fatalf("normal fit %dx%d tooSmall %v", g.cols, g.rows, g.tooSmall)
	}
	rows, cols := g.rows, g.cols
	g.layout(terminal.Options{}, 13, ui.Rect{W: 800, H: headH + 2}, 2, s)
	if !g.tooSmall || g.rows != rows || g.cols != cols {
		t.Fatalf("short reported %dx%d tooSmall %v, want the last fit kept", g.cols, g.rows, g.tooSmall)
	}
	mid := headH + sidePad(2) + g.ch*3
	g.layout(terminal.Options{}, 13, ui.Rect{W: 800, H: mid}, 2, s)
	if g.tooSmall || g.rows == rows || g.rows < 1 {
		t.Fatalf("a taller window stayed at %d (tooSmall %v)", g.rows, g.tooSmall)
	}
	g.layout(terminal.Options{}, 13, ui.Rect{W: g.cw}, 1.5, s)
	if !g.tooSmall || g.cols != cols {
		t.Fatalf("narrow reported %dx%d", g.cols, g.rows)
	}
	g.layout(terminal.Options{}, 13, fit, 2, s)
	if g.tooSmall || g.rows != rows || g.cols != cols {
		t.Fatalf("restored %dx%d tooSmall %v", g.cols, g.rows, g.tooSmall)
	}
	for _, mode := range []string{"split", "zoom"} {
		framed := herdrAnswer(80, 24, mode)
		g.layout(terminal.Options{}, 13, ui.Rect{W: 800, H: g.ch / 2}, 2, framed)
		if !g.tooSmall {
			t.Fatalf("%s half a cell was treated as a row", mode)
		}
		g.layout(terminal.Options{}, 13, fit, 2, framed)
		if g.tooSmall || g.rows < 2 {
			t.Fatalf("%s did not restore (%dx%d)", mode, g.cols, g.rows)
		}
	}
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

func TestPopupHidesHeaderClicks(t *testing.T) {
	s := herdrAnswer(40, 20, "split")
	s.Popup = &herdr.Popup{TerminalID: "pop", Frame: herdr.Frame{W: 4, H: 2}}
	v := frameAt(s, 320, 320, 8, 16, 1)
	v.pane, v.tab = "a", "t"
	ps := frameAt(s, v.w, v.h, v.cw, v.ch, v.scale).places
	h := ps[1].head
	for _, button := range []int{0, 1} {
		var in interaction
		_, fx := in.handle(ui.InputEvent{Kind: ui.InputPointerDown, X: h.X + 2, Y: h.Y + h.H/2, Button: button}, v)
		for _, f := range fx {
			switch f.(type) {
			case focusPane, openPaneMenu:
				t.Fatalf("button %d on a hidden header: %v", button, fx)
			}
		}
	}
}
