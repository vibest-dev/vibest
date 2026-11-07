package app

import (
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"

	"github.com/egoist/mygo/ui"
)

func TestShellLayoutGeometry(t *testing.T) {
	for _, scale := range []float32{1, 1.25, 2} {
		for _, hidden := range []bool{false, true} {
			for _, size := range [][2]int{{1280, 800}, {800, 600}, {1207, 880}} {
				state := "open"
				if hidden {
					state = "closed"
				}
				t.Run(fmt.Sprintf("%dx%d-x%g-%s", size[0], size[1], scale, state), func(t *testing.T) {
					checkShell(t, size[0], size[1], scale, hidden, "single")
				})
			}
		}
	}
	for _, mode := range []string{"split", "stack", "nested", "zoom"} {
		t.Run(mode, func(t *testing.T) {
			checkShell(t, 1280, 800, 2, false, mode)
		})
	}
	t.Run("disconnected", func(t *testing.T) {
		_, _, tt := coreShellFixture(t, 1280, 800, 1, false, "")
		tt.Frame()
		win, side, col := find(t, tt, "window-chrome"), find(t, tt, "sidebar"), find(t, tt, "main-column")
		if win.H != windowChromeMin || side.Y != 0 || side.Y+side.H != 800 || col.X != side.X+side.W+3 || win.X != col.X {
			t.Fatalf("disconnected window %v sidebar %v column %v", win, side, col)
		}
		disc := find(t, tt, "disconnected")
		if disc.X < col.X-0.5 || disc.Y < col.Y-0.5 || disc.X+disc.W > col.X+col.W+0.5 || disc.Y+disc.H > col.Y+col.H+0.5 {
			t.Fatalf("disconnected card %v outside the column %v", disc, col)
		}
		if _, ok := tt.Find("Panes"); ok {
			t.Fatal("disconnected window drew a terminal")
		}
		shotShell(t, tt, "disconnected")
	})
	t.Run("mid-slide", func(t *testing.T) {
		_, _, tt := coreShellFixture(t, 1280, 800, 2, false, "single")
		tt.Frame()
		full := find(t, tt, "main-column").X
		btn := find(t, tt, "Hide sidebar")
		if err := tt.Click("Hide sidebar"); err != nil {
			t.Fatal(err)
		}
		tt.Advance(sidebarMotion.Duration / 2)
		col := find(t, tt, "main-column")
		side, grip := find(t, tt, "sidebar"), find(t, tt, "sidebar-grip")
		if col.X <= sideGutter || col.X >= full || side.W != col.X-3 || grip.X != col.X-3 {
			t.Fatalf("mid-slide column %v sidebar %v grip %v, from %v", col, side, grip, full)
		}
		if got := find(t, tt, "Show sidebar"); got.X != btn.X || got.Y != btn.Y {
			t.Fatalf("toggle moved during the slide: %v from %v", got, btn)
		}
		panes := find(t, tt, "Panes")
		if panes.X != col.X || panes.W != col.W {
			t.Fatalf("mid-slide panes %v column %v", panes, col)
		}
		gap := find(t, tt, "pane-gap")
		bar := find(t, tt, "tab-bar")
		win := find(t, tt, "window-chrome")
		tab := find(t, tt, "tab/t")
		seen := panes.Y - (tab.Y + tab.H)
		if bar.Y+bar.H > win.Y+win.H+0.5 || panes.Y < tab.Y+tab.H || !near1(seen, outerPad, 0.5/2) || panes.Y < gap.Y+gap.H-0.5 {
			t.Fatalf("mid-slide header %v tab %v gap %v panes %v seen %v", win, tab, gap, panes, seen)
		}
		shotShell(t, tt, "mid-slide")
	})
}

func TestShellLayoutKeepsThemeRoles(t *testing.T) {
	const scale float32 = 2
	for _, name := range chrome.Builtins {
		th, ok := chrome.Builtin(name)
		if !ok {
			t.Fatal(name)
		}
		app, _, tt := coreShellFixture(t, 1280, 800, scale, false, "single")
		app.themes.light, app.themes.dark = th, th
		tt.SetDark(th.Dark)
		tt.Frame()
		tt.Frame()
		img := tt.Image()
		win := find(t, tt, "window-chrome")
		side := find(t, tt, "sidebar")
		bar := find(t, tt, "tab-bar")
		panes := find(t, tt, "Panes")
		col := find(t, tt, "main-column")
		at := func(x, y float32) (int, int) { return int(x * scale), int(y * scale) }
		check := func(what string, x, y int, want ui.Color) {
			t.Helper()
			if got := img.RGBAAt(x, y); !nearColor(got, want) {
				t.Errorf("%s %s at %d,%d is %v, want %v", name, what, x, y, got, want)
			}
		}
		x, y := at(win.X+win.W-4, win.H/2)
		check("window row", x, y, th.Background)
		x, y = at(8, side.Y+40)
		check("sidebar", x, y, th.Sidebar)
		grip := find(t, tt, "sidebar-grip")
		x, y = at(grip.X+grip.W-0.5, side.Y+80)
		check("sidebar grip", x, y, th.Sidebar)
		x, y = at(bar.X+bar.W-12, bar.Y+bar.H/2)
		check("tab bar", x, y, th.TabBar)
		x, y = at(panes.X+panes.W/2, panes.Y+panes.H/2)
		check("terminal", x, y, th.Terminal.Background)
		x, y = at(1278, col.Y+col.H/2)
		check("right margin", x, y, th.Background)
		tab := find(t, tt, "tab/t")
		gap := find(t, tt, "pane-gap")
		if panes.Y < tab.Y+tab.H-0.5 || panes.Y < gap.Y+gap.H-0.5 {
			t.Fatalf("%s: tab %v gap %v panes %v", name, tab, gap, panes)
		}
		x, y = at(panes.X+40, (tab.Y+tab.H+panes.Y)/2)
		check("gap under tabs", x, y, th.Background)
		x, y = at(panes.X+cardRadius(scale)+8, panes.Y+gridLine(scale)/2)
		check("card stroke", x, y, th.Border)
		if name == "Newsprint" && th.Background == th.Sidebar {
			t.Fatal("Newsprint no longer distinguishes the window background from the sidebar")
		}
		shotShell(t, tt, "theme-"+name)
	}
}

func TestShellLayoutMarginIsNotACell(t *testing.T) {
	app, f, tt := coreShellFixture(t, 1280, 800, 2, false, "single")
	pl := corePaneGeometries(t, app, tt)[0]
	coreOutput(t, app, f, tt, "a", fmt.Sprintf("\x1b[?1002h\x1b[?1006h\x1b[%d;%dH", pl.rows, pl.cols))
	panes := find(t, tt, "Panes")
	cellX := panes.X + pl.term.X + float32(pl.cols-1)*pl.cw
	cellY := panes.Y + pl.term.Y + float32(pl.rows-1)*pl.ch
	if cellX+pl.cw > panes.X+panes.W+.5 || cellY+pl.ch > 800-outerPad {
		t.Fatal("bottom-right VT cell escaped", pl)
	}
	caret, ok := tt.TextCaret()
	if !ok || !near1(caret.X, cellX, .5) || !near1(caret.Y, cellY, .5) {
		t.Fatalf("caret %v/%v, want %v,%v", caret, ok, cellX, cellY)
	}
	tt.ClickAt(1276, 796)
	noCoreData(t, f)
	tt.ClickAt(cellX+pl.cw/2, cellY+pl.ch/2)
	wantCorePaneInput(t, f, "a", fmt.Sprintf("\x1b[<0;%d;%dM", pl.cols, pl.rows))
	wantCorePaneInput(t, f, "a", fmt.Sprintf("\x1b[<0;%d;%dm", pl.cols, pl.rows))
	shotShell(t, tt, "cell")
}

func compactGutters(t *testing.T, scale float32) {
	t.Helper()
	if outerPad != 8 || sideGutter != 4 || interPane != 4 {
		t.Fatalf("edges right/bottom %v left %v between %v", outerPad, sideGutter, interPane)
	}
	chromeH := onPixel(windowChromeMin, scale)
	tabH := chrome.Step24
	gap := headerGap(chromeH, tabH, scale)
	seen := (chromeH-tabH)/2 + gap
	if !nearDip(cardGap(scale), onPixel(interPane, scale)) || !near1(seen, outerPad, 0.5/scale) {
		t.Fatalf("scale %v between %v seen under tab %v gap under band %v", scale, cardGap(scale), seen, gap)
	}
	if gap >= 0 {
		t.Fatal("the header band's own padding was counted again under the tab")
	}
	if headH != 28 || sides != 6 || termBottom != 4 {
		t.Fatalf("reserves header %v side %v bottom %v, want 28, 6, 4", headH, sides, termBottom)
	}
	if !nearDip(cardRadius(scale), onPixel(windowCorner/2, scale)) || nearDip(cardRadius(scale), sidePad(scale)) {
		t.Fatalf("radius %v, want half of window corner %v, not the side pad %v", cardRadius(scale), windowCorner, sidePad(scale))
	}
}

func TestCardSliverStaysUnderTheTab(t *testing.T) {
	const scale float32 = 2
	_, _, tt := coreShellFixture(t, 1280, 800, scale, false, "single")
	win, tab, panes := find(t, tt, "window-chrome"), find(t, tt, "tab/t"), find(t, tt, "Panes")
	if panes.Y < tab.Y+tab.H {
		t.Fatalf("card %v covers tab %v", panes, tab)
	}
	sliver := win.Y + win.H - panes.Y
	if sliver <= 0 || sliver > 2 {
		t.Fatalf("card enters the header by %v, want about 1", sliver)
	}
	img := tt.Image()
	px, py := int((panes.X+panes.W/2)*scale), int((panes.Y+sliver/2)*scale)
	if nearColor(img.RGBAAt(px, py), chrome.Light.Background) && !nearColor(img.RGBAAt(px, py), chrome.Light.Terminal.Background) {
		t.Fatalf("header covers the card at %d,%d: %v", px, py, img.RGBAAt(px, py))
	}
	if err := tt.Click("tab/t"); err != nil {
		t.Fatal(err)
	}
	if _, ok := tt.Find("tab/t"); !ok {
		t.Fatal("tab click missed the control")
	}
}

func TestCompactSpacingMeasuresGutters(t *testing.T) {
	const scale float32 = 2
	app, _, tt := coreShellFixture(t, 1280, 800, scale, false, "stack")
	win := find(t, tt, "window-chrome")
	gap := find(t, tt, "pane-gap")
	col := find(t, tt, "main-column")
	panes := find(t, tt, "Panes")
	bottom := float32(800) - (col.Y + col.H)
	right := float32(1280) - (col.X + col.W)
	tab := find(t, tt, "tab/t")
	seen := panes.Y - (tab.Y + tab.H)
	if gap.H != 0 {
		t.Fatalf("gap box %v, want the overlap in the margin", gap)
	}
	if !near1(seen, outerPad, 0.5/scale) || !nearDip(bottom, outerPad) || !nearDip(right, outerPad) {
		t.Fatalf("under tab %v (band ends %v, card %v) bottom %v right %v, want 8", seen, win.Y+win.H, panes.Y, bottom, right)
	}
	if panes.Y < tab.Y+tab.H || !nearDip(panes.Y+panes.H, col.Y+col.H) {
		t.Fatalf("panes %v window %v tab %v column %v", panes, win, tab, col)
	}
	places := corePaneGeometries(t, app, tt)
	if len(places) != 2 {
		t.Fatalf("stack places %d", len(places))
	}
	ch := places[0].ch
	a, b := places[0], places[1]
	betweenCards := b.card.Y - (a.card.Y + a.card.H)
	if !nearDip(betweenCards, 4) {
		t.Fatalf("vertical sibling gap %v, want 4 (was 8)", betweenCards)
	}
	for _, pl := range places {
		below := pl.card.Y + pl.card.H - (pl.term.Y + pl.term.H)
		if !nearDip(pl.head.H, 28) || !nearDip(pl.term.X-pl.card.X, sidePad(scale)) || !nearDip(pl.term.Y, pl.card.Y+headH) {
			t.Fatalf("pane %s header/side/top %+v", pl.id, pl)
		}
		if below < bottomPad(scale)-0.01 || below >= bottomPad(scale)+ch {
			t.Fatalf("pane %s leftover %v, want it under the last row and under one cell %v", pl.id, below, ch)
		}
	}
	if a.rows < b.rows {
		t.Fatalf("rows moved onto the lower pane: %d over %d", a.rows, b.rows)
	}

	hidden, _, htt := coreShellFixture(t, 1280, 800, scale, true, "split")
	gutter := find(t, htt, "sidebar-gutter")
	hcol := find(t, htt, "main-column")
	if !nearDip(gutter.W, sideGutter) || !nearDip(float32(1280)-(hcol.X+hcol.W), outerPad) {
		t.Fatalf("closed left %v right %v, want 4 and 8", gutter.W, 1280-(hcol.X+hcol.W))
	}
	hs := corePaneGeometries(t, hidden, htt)
	if len(hs) != 2 {
		t.Fatal("split places")
	}
	if side := hs[1].card.X - (hs[0].card.X + hs[0].card.W); !nearDip(side, 4) {
		t.Fatalf("horizontal sibling gap %v, want 4 (was 8)", side)
	}
	t.Logf("tab bottom %.2f header band %.2f card %.2f seen %.2f; bottom/right %.0f; between cards %.2f; closed left %.0f; header 28 side %.2f bottom reserve %.2f; stack rows %d/%d cell %.2f", tab.Y+tab.H, win.Y+win.H, panes.Y, seen, outerPad, betweenCards, sideGutter, sidePad(scale), bottomPad(scale), a.rows, b.rows, ch)
}

func TestPaneStyleKeepsTheLinearShellUnlessCompact(t *testing.T) {
	const scale float32 = 2
	if got := (&App{}).paneStyle(); got != paneComfortable {
		t.Fatalf("empty choice %q, want comfortable", got)
	}
	app, f, tt := coreShellFixture(t, 1280, 800, scale, false, "split")
	if _, ok := tt.Find("window-chrome"); !ok {
		t.Fatal("comfortable lost the window header")
	}
	if !nearDip(app.shell().cardRadius(scale), onPixel(windowCorner/2, scale)) {
		t.Fatalf("comfortable radius %v", app.shell().cardRadius(scale))
	}
	app.themes.settings.PaneStyle = paneCompact
	tt.Frame()
	tt.Advance(paneStyleMotion.Duration + styleFrame)
	if _, ok := tt.Find("window-chrome"); ok {
		t.Fatal("compact still draws the linear window header")
	}
	bar := find(t, tt, "tab-bar")
	side := find(t, tt, "sidebar")
	col := find(t, tt, "main-column")
	if side.Y != 0 || col.X < side.X+side.W || bar.Y != 0 {
		t.Fatalf("compact shell sidebar %v column %v tabs %v", side, col, bar)
	}
	if app.shell().cardRadius(scale) != 0 || !nearDip(app.shell().bottomPad(scale), 2) {
		t.Fatalf("compact radius %v bottom %v, want a square shell and 2", app.shell().cardRadius(scale), app.shell().bottomPad(scale))
	}
	places := corePaneGeometries(t, app, tt)
	if len(places) == 2 {
		gap := places[1].card.X - (places[0].card.X + places[0].card.W)
		if gap > gridLine(scale)+0.6 {
			t.Fatalf("compact gap %v, want only the hairline", gap)
		}
	}
	disc, themeBtn := find(t, tt, "Terminals"), find(t, tt, "Theme")
	if !nearDip(disc.X-side.X, chrome.Step8) || !nearDip(side.X+side.W-(themeBtn.X+themeBtn.W), chrome.Step8) {
		t.Fatalf("compact sidebar disclosure %v theme %v sidebar %v, want 8-point insets", disc, themeBtn, side)
	}
	release, _ := holdCoreMethod(t, f, "terminal.attach c")
	coreAppAct(app, func() {
		app.coreEdit(func(l *core.Layout) error {
			l.Workspaces[0].Tabs = append(l.Workspaces[0].Tabs, core.Tab{ID: "late", Root: &core.Split{Pane: &core.Pane{ID: "c", Terminal: core.TerminalRef{CoreID: l.CoreID, Address: "c"}}}})
			return nil
		})
	})
	awaitCoreApp(t, app, func() bool { return app.coreState.Layout.Tab("late") != nil })
	tt.Frame()
	if err := tt.Click("tab/late"); err != nil {
		t.Fatal(err)
	}
	nav := find(t, tt, "navigation-input")
	col, bar = find(t, tt, "main-column"), find(t, tt, "tab-bar")
	if !nearDip(nav.X, col.X) || !nearDip(nav.Y, bar.Y+bar.H) {
		t.Fatalf("navigation %v, want the column's left edge under tab %v", nav, bar)
	}
	tt.Type("x")
	noCoreData(t, f)
	release()
	readyCorePane(t, app, tt, "c")
	wantCorePaneInput(t, f, "c", "x")
	kept := app.themes.settings.Theme
	app.sidebarVisible = false
	tt.Frame()
	tt.Advance(sidebarMotion.Duration)
	if _, ok := tt.Find("sidebar-gutter"); ok {
		t.Fatal("compact closed sidebar kept a gutter")
	}
	if panes := find(t, tt, "Panes"); panes.X != 0 {
		t.Fatalf("compact closed panes start at %v", panes.X)
	}
	app.themes.settings.PaneStyle = paneComfortable
	app.sidebarVisible = true
	tt.Frame()
	tt.Advance(sidebarMotion.Duration)
	if _, ok := tt.Find("window-chrome"); !ok {
		t.Fatal("switching back did not restore the window header")
	}
	if app.themes.settings.Theme != kept {
		t.Fatal("style switch changed the theme")
	}
	side = find(t, tt, "sidebar")
	disc, themeBtn = find(t, tt, "Terminals"), find(t, tt, "Theme")
	if side.Y != 0 || !nearDip(disc.X-side.X, chrome.Step8) || !nearDip(side.X+side.W-(themeBtn.X+themeBtn.W), chrome.Step8) {
		t.Fatalf("comfortable sidebar %v disclosure %v theme %v, want the original insets", side, disc, themeBtn)
	}
}

func TestTrafficLightsAreChosenWhenTheWindowOpens(t *testing.T) {
	app := newChromeTestApp()
	if app.TrafficLights().Y != macTrafficLightY {
		t.Fatalf("empty style lights Y %v, want %v", app.TrafficLights().Y, macTrafficLightY)
	}
	app.themes.settings.PaneStyle = paneCompact
	if app.TrafficLights().Y != macTrafficLightYCompact {
		t.Fatalf("compact lights Y %v, want %v", app.TrafficLights().Y, macTrafficLightYCompact)
	}
}

func checkShell(t *testing.T, w, h int, scale float32, hidden bool, mode string) {
	t.Helper()
	compactGutters(t, scale)
	app, _, tt := coreShellFixture(t, w, h, scale, hidden, mode)
	win := find(t, tt, "window-chrome")
	wantH := onPixel(windowChromeMin, scale)
	if win.Y != 0 || !nearDip(win.H, wantH) {
		t.Fatalf("window row %v, want height %g at the top", win, wantH)
	}
	col := find(t, tt, "main-column")
	var slot float32
	if hidden {
		gutter := find(t, tt, "sidebar-gutter")
		if _, ok := tt.Find("sidebar"); ok {
			t.Fatal("closed sidebar is still shown")
		}
		if gutter.X != 0 || gutter.W != sideGutter || gutter.Y != win.H || gutter.Y+gutter.H != float32(h) {
			t.Fatalf("gutter %v", gutter)
		}
		if win.X != 0 || win.W != float32(w) {
			t.Fatalf("closed header %v, want the full window", win)
		}
		slot = gutter.W
	} else {
		side, grip := find(t, tt, "sidebar"), find(t, tt, "sidebar-grip")
		if _, ok := tt.Find("sidebar-gutter"); ok {
			t.Fatal("open sidebar also reserved a gutter")
		}
		if side.X != 0 || side.Y != 0 || side.Y+side.H != float32(h) || grip.X != side.X+side.W || grip.W != 3 {
			t.Fatalf("sidebar %v grip %v", side, grip)
		}
		slot = grip.X + grip.W
		theme := find(t, tt, "Theme")
		if theme.X+theme.W != side.X+side.W-chrome.Step8 || theme.Y+theme.H != float32(h)-chrome.Step8 {
			t.Fatalf("theme %v sidebar %v", theme, side)
		}
		disc := find(t, tt, "Terminals")
		if !nearDip(disc.X, side.X+chrome.Step8) {
			t.Fatalf("sidebar row inset disc %v sidebar %v, want %v", disc, side, chrome.Step8)
		}
		if win.X != slot || !nearDip(win.W, float32(w)-slot) {
			t.Fatalf("header %v covers the sidebar; column starts at %v", win, slot)
		}
	}
	if !nearDip(col.X, slot) || !nearDip(col.X+col.W, float32(w)-outerPad) || !nearDip(col.Y+col.H, float32(h)-outerPad) {
		t.Fatalf("column %v, slot %v", col, slot)
	}
	panes := find(t, tt, "Panes")
	if !nearDip(panes.X, col.X) || !nearDip(panes.W, col.W) || !nearDip(panes.Y+panes.H, col.Y+col.H) || !nearDip(panes.W, mainPaneWidth(float32(w), slot)) {
		t.Fatalf("panes %v column %v width %v", panes, col, mainPaneWidth(float32(w), slot))
	}
	bar := find(t, tt, "tab-bar")
	gap := find(t, tt, "pane-gap")
	tab, plus := find(t, tt, "tab/t"), find(t, tt, "New tab")
	create := find(t, tt, "new-workspace")
	seen := panes.Y - (tab.Y + tab.H)
	if !nearDip(bar.Y, win.Y) || !nearDip(bar.Y+bar.H, win.Y+win.H) || panes.Y < tab.Y+tab.H || !near1(seen, outerPad, 0.5/scale) || panes.Y < gap.Y+gap.H-0.5 {
		t.Fatalf("tabs are not in the header: win %v bar %v tab %v gap %v panes %v seen %v", win, bar, tab, gap, panes, seen)
	}
	if bar.X < create.X+create.W-0.5 || tab.X < bar.X || tab.X+tab.W > bar.X+bar.W+0.5 || plus.X < tab.X || plus.X+plus.W > bar.X+bar.W+0.5 || tab.Y < win.Y || tab.Y+tab.H > win.Y+win.H+0.5 {
		t.Fatalf("tabs escaped the header band: bar %v tab %v new %v create %v", bar, tab, plus, create)
	}
	if slot > create.X+create.W+chrome.Step8 && !nearDip(bar.X, slot) {
		t.Fatalf("open sidebar: tab band %v, want it at the column %v", bar, slot)
	}
	if nearDip(bar.X, panes.X) && !nearDip(tab.X, panes.X) {
		t.Fatalf("tab %v and pane %v do not share a left edge", tab, panes)
	}
	label := "Hide sidebar"
	if hidden {
		label = "Show sidebar"
	}
	btn := find(t, tt, label)
	if btn.X != 78+chrome.Step8 || !nearDip(btn.Y, (tabBarHeight-btn.H)/2) {
		t.Fatalf("toggle %v, want it centered on the title band", btn)
	}
	places := corePaneGeometries(t, app, tt)
	if len(places) == 0 {
		t.Fatal("no fitted terminal geometry")
	}
	for _, pl := range places {
		if pl.cols < 1 || pl.rows < 1 {
			t.Fatal("no visible VT cells", pl.id)
		}
	}
	rad := cardRadius(scale)
	for i, pl := range places {
		if !inElement(pl.term, panes.W, panes.H) || panes.X+pl.term.X+pl.term.W > float32(w)-outerPad+0.5 {
			t.Fatalf("pane %s term %v outside panes %v", pl.id, pl.term, panes)
		}
		if pl.head.X < pl.card.X || pl.head.Y < pl.card.Y || pl.term.Y < pl.head.Y+pl.head.H-0.1 || pl.term.Y+pl.term.H > pl.card.Y+pl.card.H+0.1 {
			t.Fatalf("pane %s header/terminal leave its card %+v", pl.id, pl)
		}
		if !rectInsideRounded(pl.card, pl.term, rad) {
			t.Fatalf("pane %s terminal %v meets the %v corner of %v", pl.id, pl.term, rad, pl.card)
		}
		cover := gridLine(scale) + 0.5/scale
		inner := ui.Rect{X: pl.card.X + cover, Y: pl.card.Y + cover, W: pl.card.W - 2*cover, H: pl.card.H - 2*cover}
		if !rectInsideRounded(inner, pl.term, max(rad-cover, 0)) {
			t.Fatalf("pane %s terminal %v meets the stroke of %v (cover %v)", pl.id, pl.term, pl.card, cover)
		}
		btn := find(t, tt, "close-pane/"+pl.id)
		if btn.X < panes.X+pl.card.X || btn.X+btn.W > panes.X+pl.card.X+pl.card.W+0.5 || btn.Y < panes.Y+pl.card.Y || btn.Y+btn.H > panes.Y+pl.card.Y+pl.card.H {
			t.Fatalf("pane %s close %v outside card %v", pl.id, btn, pl.card)
		}
		for _, other := range places[i+1:] {
			if cardsOverlap(pl.card, other.card) {
				t.Fatalf("cards %s and %s overlap", pl.id, other.id)
			}
			if dx := between(pl.card, other.card, true); dx > 0 && dx < cardGap(scale)+2 && !nearDip(dx, cardGap(scale)) {
				t.Fatalf("horizontal gap %v between %s and %s, want %v", dx, pl.id, other.id, cardGap(scale))
			}
			if dy := between(pl.card, other.card, false); dy > 0 && dy < cardGap(scale)+2 && !nearDip(dy, cardGap(scale)) {
				t.Fatalf("vertical gap %v between %s and %s, want %v", dy, pl.id, other.id, cardGap(scale))
			}
		}
	}
	name := fmt.Sprintf("%dx%d-x%g-%s-%s", w, h, scale, map[bool]string{true: "closed", false: "open"}[hidden], mode)
	writeCoreBoxes(t, name, tt, places, panes)
	shotShell(t, tt, name)
}

func rectInsideRounded(card, inner ui.Rect, radius float32) bool {
	for _, pt := range [][2]float32{
		{inner.X, inner.Y}, {inner.X + inner.W, inner.Y},
		{inner.X, inner.Y + inner.H}, {inner.X + inner.W, inner.Y + inner.H},
	} {
		if !insideRounded(card, pt[0], pt[1], radius) {
			return false
		}
	}
	return true
}

func insideRounded(card ui.Rect, x, y, radius float32) bool {
	if x < card.X-0.01 || y < card.Y-0.01 || x > card.X+card.W+0.01 || y > card.Y+card.H+0.01 {
		return false
	}
	dx := min(x-card.X, card.X+card.W-x)
	dy := min(y-card.Y, card.Y+card.H-y)
	if dx >= radius-0.01 || dy >= radius-0.01 {
		return true
	}
	ex, ey := radius-dx, radius-dy
	return ex*ex+ey*ey <= radius*radius+0.01
}

func cardsOverlap(a, b ui.Rect) bool {
	return a.X < b.X+b.W-0.01 && b.X < a.X+a.W-0.01 && a.Y < b.Y+b.H-0.01 && b.Y < a.Y+a.H-0.01
}

func between(a, b ui.Rect, across bool) float32 {
	if across {
		if a.Y+a.H <= b.Y+0.01 || b.Y+b.H <= a.Y+0.01 {
			return 0
		}
		if a.X+a.W <= b.X {
			return b.X - (a.X + a.W)
		}
		if b.X+b.W <= a.X {
			return a.X - (b.X + b.W)
		}
		return 0
	}
	if a.X+a.W <= b.X+0.01 || b.X+b.W <= a.X+0.01 {
		return 0
	}
	if a.Y+a.H <= b.Y {
		return b.Y - (a.Y + a.H)
	}
	if b.Y+b.H <= a.Y {
		return a.Y - (b.Y + b.H)
	}
	return 0
}

func writeCoreBoxes(t *testing.T, name string, tt *ui.Tester, places []corePaneGeometry, panes ui.Rect) {
	t.Helper()
	dir := os.Getenv("SHELL_SHOTS")
	if dir == "" {
		return
	}
	var b []byte
	for _, label := range []string{"window-chrome", "sidebar", "sidebar-gutter", "tab-bar", "pane-gap", "main-column", "Panes"} {
		r, ok := tt.Find(label)
		if ok {
			b = fmt.Appendf(b, "%s\t%.2f,%.2f %.2fx%.2f\n", label, r.X, r.Y, r.W, r.H)
		}
	}
	for _, pl := range places {
		b = fmt.Appendf(b, "card/%s\t%.2f,%.2f %.2fx%.2f head %.2f,%.2f term %.2f,%.2f %.2fx%.2f\n",
			pl.id, panes.X+pl.card.X, panes.Y+pl.card.Y, pl.card.W, pl.card.H,
			panes.X+pl.head.X, panes.Y+pl.head.Y, panes.X+pl.term.X, panes.Y+pl.term.Y, pl.term.W, pl.term.H)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".boxes.txt"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func shotShell(t *testing.T, tt *ui.Tester, name string) {
	t.Helper()
	dir := os.Getenv("SHELL_SHOTS")
	if dir == "" {
		return
	}
	f, err := os.Create(filepath.Join(dir, name+".png"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, tt.Image()); err != nil {
		t.Fatal(err)
	}
}
