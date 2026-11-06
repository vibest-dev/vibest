package app

import (
	"fmt"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"reflect"
	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

type paneRect struct{ X, Y, Width, Height int }

func themedCoreApp(t *testing.T, dir string) (*App, *coreAppFixture, *ui.Tester, paneRect) {
	t.Helper()
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified software VT required")
	}
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		coreActivitySeed(f)
		f.layout.Workspaces[0].Label = "reherdr"
		f.layout.Workspaces[0].Tabs[0].ID = "t"
		f.layout.Workspaces[1].Label = "notes"
	})
	if dir != "" {
		a.LoadThemes(dir)
	}
	coreAppAct(a, func() { a.look.NoBlink = true })
	tt := ui.NewTester(a.View, 1280, 800)
	tt.SetDark(false)
	readyCorePane(t, a, tt, "a")
	awaitCorePaintWithoutOwnership(t, a, tt, "b")
	coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[1;2H")
	coreOutput(t, a, f, tt, "b", "\x1b[2J\x1b[H")
	r := find(t, tt, "Panes")
	return a, f, tt, paneRect{X: int(r.X), Y: int(r.Y), Width: int(r.W), Height: int(r.H)}
}
func themedApp(t *testing.T, dir string) (*App, *ui.Tester, paneRect) {
	a, _, tt, r := themedCoreApp(t, dir)
	return a, tt, r
}
func typeInto(app *App, id string) { app.mu.Lock(); defer app.mu.Unlock(); app.ShowPane(id) }

func shot(t *testing.T, tt *ui.Tester, name string) {
	dir := os.Getenv("THEME_SHOTS")
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

func look(t *testing.T, app *App, tt *ui.Tester, panes paneRect, th *chrome.Theme) {
	t.Helper()
	img := tt.Image()
	ps := corePaneGeometries(t, app, tt)
	a, b := ps[0], ps[1]
	cw, ch := a.cw, a.ch
	l := ui.Rect{X: a.card.X + a.card.W, W: b.card.X - (a.card.X + a.card.W)}
	check := func(what string, x, y int, want ui.Color) {
		t.Helper()
		if got := img.RGBAAt(x, y); !nearColor(got, want) {
			t.Errorf("%s: %s at %d,%d is %v, want %v", th.Name, what, x, y, got, want)
		}
	}
	check("sidebar", 4, 300, th.Sidebar)
	bar, _ := tt.Find("tab-bar")
	check("tab strip", int(bar.X+bar.W)-8, int(bar.Y+bar.H/2), th.TabBar)
	check("pane surround", panes.X+int(b.term.X+b.cw*2.5), panes.Y+int(b.term.Y+b.ch*3.5), th.Terminal.Background.Mix(th.Foreground, inactiveVeil))
	name, _ := tt.Find("reherdr")
	check("selected row", int(name.X)-24, int(name.Y+name.H/2), th.Row.Active.Background)
	check("pane", panes.X+int(a.term.X+cw*2.5), panes.Y+int(a.term.Y+ch*3.5), th.Terminal.Background)
	check("cursor", panes.X+int(a.term.X+cw*1)+1, panes.Y+int(a.term.Y)+1, th.Terminal.Cursor)
	check("card gap", panes.X+int(l.X+l.W/2), panes.Y+int(a.term.Y+ch*2), th.Background)
	check("gutter", panes.X-4, panes.Y+int(ch*2), th.Container.Background)
}

func TestThemeSwitchKeepsTheSessionAndRepaints(t *testing.T) {
	dir := t.TempDir()
	app, f, tt, panes := themedCoreApp(t, dir)
	look(t, app, tt, panes, chrome.Light)
	shot(t, tt, "paper")
	before := tt.Image()
	pixels := append([]byte(nil), before.Pix...)
	v := app.coreViews["a"]
	layout := app.coreState.Layout
	geometry := corePaneGeometries(t, app, tt)
	coreAppAct(app, func() { app.followSystem(false); app.chooseTheme("Nord", false) })
	tt.Frame()
	look(t, app, tt, panes, chrome.Dark)
	shot(t, tt, "nord")
	if reflect.DeepEqual(pixels, tt.Image().Pix) || app.coreViews["a"] != v || !reflect.DeepEqual(layout, app.coreState.Layout) || !reflect.DeepEqual(geometry, corePaneGeometries(t, app, tt)) {
		t.Fatal("theme failed to repaint or changed session/geometry")
	}
	coreAppAct(app, func() { app.chooseTheme("Paper", false) })
	tt.Frame()
	look(t, app, tt, panes, chrome.Light)
	tt.Type("x")
	wantCorePaneInput(t, f, "a", "x")
	noLegacyNavigation(t, f)
	if s, err := chrome.LoadSettings(dir); err != nil || s.Theme != "Paper" || s.FollowSystem {
		t.Fatalf("saved %+v %v", s, err)
	}
}

func TestFollowSystemUsesTheDarkChoice(t *testing.T) {
	dir := t.TempDir()
	app, tt, panes := themedApp(t, dir)
	tt.SetDark(true)
	tt.Frame()
	look(t, app, tt, panes, chrome.Dark)
	tt.SetDark(false)
	tt.Frame()
	look(t, app, tt, panes, chrome.Light)
	if got := app.wantAppearance(); got != "system" {
		t.Fatalf("appearance %q", got)
	}
	app.mu.Lock()
	app.followSystem(false)
	app.chooseTheme("Nord", false)
	app.mu.Unlock()
	if got := app.wantAppearance(); got != "dark" {
		t.Fatalf("appearance %q, want dark for Nord", got)
	}
	tt.SetDark(false)
	tt.Frame()
	look(t, app, tt, panes, chrome.Dark)
}

func TestThemeMenu(t *testing.T) {
	dir := t.TempDir()
	app, tt, _ := themedApp(t, dir)
	if err := tt.Click("Theme"); err != nil {
		t.Fatal(err)
	}
	menu := tt.Menu()
	for _, want := range []string{"Light Appearance", "Dark Appearance", "Follow System Appearance"} {
		if !slices.Contains(menu, want) {
			t.Fatalf("menu %v lacks %q", menu, want)
		}
	}
	for _, gone := range []string{"Reload Themes", "Open Themes Folder"} {
		if slices.Contains(menu, gone) {
			t.Fatalf("menu %v still has %q", menu, gone)
		}
	}
	newsprint, _ := chrome.Builtin("Newsprint")
	if err := tt.ChooseMenuItem("Light Appearance", "Newsprint"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	name, _ := tt.Find("reherdr")
	if got := tt.Image().RGBAAt(int(name.X)-24, int(name.Y+name.H/2)); !nearColor(got, newsprint.Row.Active.Background) {
		t.Fatalf("selected row %v, want Newsprint's %v", got, newsprint.Row.Active.Background)
	}
	if err := tt.Click("Theme"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Follow System Appearance"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if err := tt.Click("Theme"); err != nil {
		t.Fatal(err)
	}
	if menu := tt.Menu(); !slices.Contains(menu, "Paper") || !slices.Contains(menu, "Newsprint") || slices.Contains(menu, "Light Appearance") {
		t.Fatalf("menu without following the system %v", menu)
	}
	if s, _ := chrome.LoadSettings(dir); s.Theme != "Newsprint" || s.FollowSystem {
		t.Fatalf("saved %+v", s)
	}
	app.mu.Lock()
	bar := app.appMenu()
	app.mu.Unlock()
	var theme *mygo.MenuItem
	for _, it := range bar.Items() {
		if it.Label == "Theme" {
			theme = it
		}
	}
	if theme == nil {
		t.Fatal("no Theme menu in the menu bar")
	}
	var nord *mygo.MenuItem
	for _, it := range theme.Submenu {
		if it.Label == "Newsprint" && !it.Checked || it.Label == "Paper" && it.Checked {
			t.Fatalf("menu bar checks %q %v", it.Label, it.Checked)
		}
		if it.Label == "Nord" {
			nord = it
		}
	}
	nord.Click(nord, nil)
	tt.Frame()
	if got := tt.Image().RGBAAt(4, 300); !nearColor(got, chrome.Dark.Sidebar) {
		t.Fatalf("sidebar %v after Theme > Nord in the menu bar", got)
	}
}

func TestBadThemeChoiceRecovers(t *testing.T) {
	dir := t.TempDir()
	if err := chrome.SaveSettings(dir, chrome.Settings{Theme: "Gone", ThemeDark: "Broken", FollowSystem: true}); err != nil {
		t.Fatal(err)
	}
	app, tt, panes := themedApp(t, dir)
	look(t, app, tt, panes, chrome.Light)
	note := app.themes.note
	if !strings.Contains(note, `"Gone"`) || !strings.Contains(note, `"Broken"`) || !strings.Contains(note, "Using") {
		t.Fatalf("note %q", note)
	}
	if !tt.HasText(note) {
		t.Fatal("the note is not shown")
	}
	tt.SetDark(true)
	tt.Frame()
	look(t, app, tt, panes, chrome.Dark)
	if err := tt.Click("Dismiss"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if tt.HasText(note) {
		t.Fatal("dismissed note still shown")
	}

	bad := t.TempDir()
	if err := os.WriteFile(filepath.Join(bad, "settings.json"), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	app2, _, _ := themedApp(t, bad)
	if app2.themes.settings != chrome.DefaultSettings() || !strings.Contains(app2.themes.note, "could not be read") {
		t.Fatalf("bad settings %+v %q", app2.themes.settings, app2.themes.note)
	}
}

func TestGhosttyChoice(t *testing.T) {
	term := &terminal.Theme{Background: ui.Hex("#102030"), Foreground: ui.Hex("#eeeeee")}
	app := newChromeTestApp()
	app.SetLook(terminal.Options{Theme: term})
	dir := t.TempDir()
	app.LoadThemes(dir)
	if app.themes.settings != chrome.DefaultSettings() || app.theme(false) != chrome.Light || app.theme(true) != chrome.Dark {
		t.Fatalf("a first start with a Ghostty theme gets %+v", app.themes.settings)
	}
	if !slices.Contains(app.catalog(), chrome.GhosttyName) {
		t.Fatal("Ghostty is not offered to a Ghostty user")
	}
	if err := chrome.SaveSettings(dir, chrome.Settings{Theme: chrome.GhosttyName, ThemeDark: chrome.GhosttyName, FollowSystem: true}); err != nil {
		t.Fatal(err)
	}
	app.LoadThemes(dir)
	th := app.theme(true)
	if app.themes.settings.Theme != chrome.GhosttyName || th.Terminal.Background != ui.Hex("#102030") || !th.Dark {
		t.Fatalf("saved Ghostty choice %+v theme %+v", app.themes.settings, th)
	}
	if slices.Contains(newChromeTestApp().catalog(), chrome.GhosttyName) {
		t.Fatal("Ghostty offered without a Ghostty theme")
	}
}

func TestWindowFocusStylesTheSelection(t *testing.T) {
	app, tt, _ := themedApp(t, "")
	name, _ := tt.Find("reherdr")
	x, y := int(name.X)-24, int(name.Y+name.H/2)
	app.Focus(false)
	tt.Frame()
	if got := tt.Image().RGBAAt(x, y); !nearColor(got, chrome.Light.Row.ActiveUnfocused.Background) {
		t.Fatalf("unfocused row %v", got)
	}
	other, _ := tt.Find("notes")
	tt.Move(other.X+4, other.Y+other.H/2)
	if got := tt.Image().RGBAAt(int(other.X)-24, int(other.Y+other.H/2)); !nearColor(got, chrome.Light.Row.Hover.Background) {
		t.Fatalf("hovered row %v, want %v", got, chrome.Light.Row.Hover.Background)
	}
	tab, _ := tt.Find("tab/t")
	if got := tt.Image().RGBAAt(int(tab.X+tab.W*0.7), int(tab.Y+tab.H/2)); !nearColor(got, chrome.Light.Tab.ActiveUnfocused.Background) {
		t.Fatalf("selected tab %v", got)
	}
}

func TestThemeFontChangesTheCells(t *testing.T) {
	a, tt, _ := themedApp(t, "")
	before := corePaneGeometries(t, a, tt)[0]
	v := a.coreViews["a"]
	coreAppAct(a, func() {
		tall := *chrome.Light
		tall.FontMonoSize = 16
		tall.CellHeight = 1.25
		a.themes.light = &tall
		a.themes.settings.FollowSystem = false
	})
	tt.Frame()
	after := corePaneGeometries(t, a, tt)[0]
	if a.coreViews["a"] != v || after.cw <= before.cw || after.ch < before.ch*1.25*16/13-1 {
		t.Fatalf("cell %vx%v → %vx%v", before.cw, before.ch, after.cw, after.ch)
	}
}

func TestPaneGeometryAtFractionalScale(t *testing.T) {
	a, f, tt, _ := themedCoreApp(t, "")
	tt.SetScale(1.5)
	tt.Frame()
	ps := corePaneGeometries(t, a, tt)
	origin := find(t, tt, "Panes")
	p := ps[0]
	caret, ok := tt.TextCaret()
	if !ok || !near1(caret.X, origin.X+p.term.X+p.cw, .5) || !near1(caret.Y, origin.Y+p.term.Y, .5) {
		t.Fatal("fractional caret differs from painted cell", caret)
	}
	v := coreOutput(t, a, f, tt, "b", "\x1b[?1002h\x1b[?1006h")
	coreAppAct(a, func() { a.ShowPane("b") })
	readyCorePane(t, a, tt, "b")
	r := vtCell(t, tt, v, "b", 2, 0)
	tt.ClickAt(float32(r.Min.X+r.Max.X)/3, float32(r.Min.Y+r.Max.Y)/3)
	readyCorePane(t, a, tt, "b")
	wantCorePaneInput(t, f, "b", "\x1b[<0;3;1M")
	wantCorePaneInput(t, f, "b", "\x1b[<0;3;1m")
	x, y := origin.X+ps[0].card.W+cardGap(1.5)/2, origin.Y+100
	tt.Press(x, y)
	tt.Move(x-p.cw, y)
	tt.Release(x-p.cw, y)
	awaitCoreApp(t, a, func() bool { return a.coreState.Version > 0 })
	ratio := a.coreState.Layout.Tab("t").Root.Ratio
	want := .5 - float64(p.cw/origin.W)
	if math.Abs(ratio-want) > .01 {
		t.Fatal("fractional drag", ratio, want)
	}
	noCoreData(t, f)
}

func menuItem(m *mygo.Menu, path ...string) *mygo.MenuItem {
	items := m.Items()
	var it *mygo.MenuItem
	for _, label := range path {
		it = nil
		for _, x := range items {
			if x.Label == label {
				it = x
			}
		}
		if it == nil {
			return nil
		}
		items = it.Submenu
	}
	return it
}

func TestStaleMenuBarActionsAndRapidSwitching(t *testing.T) {
	dir := t.TempDir()
	app, tt, panes := themedApp(t, dir)
	var mu sync.Mutex
	var bar *mygo.Menu
	var looks []string
	app.Attach(Host{
		SetMenu:       func(m *mygo.Menu) { mu.Lock(); bar = m; mu.Unlock() },
		SetAppearance: func(s string) { mu.Lock(); looks = append(looks, s); mu.Unlock() },
	})
	app.mu.Lock()
	stale := app.appMenu()
	app.mu.Unlock()
	follow := menuItem(stale, "Theme", "Follow System Appearance")
	if follow == nil || !follow.Checked {
		t.Fatal("no checked Follow item")
	}
	follow.Click(follow, nil)
	follow.Click(follow, nil)
	for i := range 40 {
		pair := []string{"Paper", "Nord"}
		light, dark := pair[i%2], pair[(i+1)%2]
		if it := menuItem(stale, "Theme", "Light Appearance", light); it != nil {
			it.Click(it, nil)
		}
		app.mu.Lock()
		app.chooseTheme(dark, true)
		app.mu.Unlock()
	}
	want := chrome.Settings{Theme: "Nord", ThemeDark: "Paper", FollowSystem: true}
	if s, err := chrome.LoadSettings(dir); err != nil || s != want {
		t.Fatalf("saved %+v %v, want %+v", s, err, want)
	}
	shows := func() bool {
		mu.Lock()
		defer mu.Unlock()
		f := menuItem(bar, "Theme", "Follow System Appearance")
		l := menuItem(bar, "Theme", "Light Appearance", "Nord")
		d := menuItem(bar, "Theme", "Dark Appearance", "Paper")
		p := menuItem(bar, "Theme", "Light Appearance", "Paper")
		return bar != nil && f != nil && f.Checked && l != nil && l.Checked && d != nil && d.Checked && p != nil && !p.Checked &&
			len(looks) > 0 && looks[len(looks)-1] == "system"
	}
	deadline := time.Now().Add(2 * time.Second)
	for !shows() {
		if time.Now().After(deadline) {
			t.Fatalf("the menu bar did not settle on the last choice; appearances %v", looks)
		}
		time.Sleep(5 * time.Millisecond)
	}
	tt.SetDark(false)
	tt.Frame()
	look(t, app, tt, panes, chrome.Dark)
	tt.SetDark(true)
	tt.Frame()
	look(t, app, tt, panes, chrome.Light)
}

func TestWindowTakesTheThemesLightness(t *testing.T) {
	dir := t.TempDir()
	app, tt, _ := themedApp(t, dir)
	var mu sync.Mutex
	look, dark := "", false
	app.Attach(Host{
		SetAppearance: func(s string) { mu.Lock(); look = s; mu.Unlock() },
		SetWindowDark: func(d bool) { mu.Lock(); dark = d; mu.Unlock() },
	})
	settle := func(name, wantLook string, wantDark bool) {
		t.Helper()
		tt.Frame()
		deadline := time.Now().Add(2 * time.Second)
		for {
			mu.Lock()
			l, d := look, dark
			mu.Unlock()
			if l == wantLook && d == wantDark {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s: app %q window dark %v, want %q and %v", name, l, d, wantLook, wantDark)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	choose := func(name string, darkSlot bool) {
		app.mu.Lock()
		app.chooseTheme(name, darkSlot)
		app.mu.Unlock()
	}
	tt.SetDark(false)
	choose("Nord", false)
	settle("light OS, Nord", "system", true)
	if app.th != chrome.Dark {
		t.Fatalf("theme %q, want Nord", app.th.Name)
	}
	choose("Paper", true)
	tt.SetDark(true)
	settle("dark OS, Paper", "system", false)
	tt.SetDark(false)
	settle("back to light OS", "system", true)
	app.mu.Lock()
	app.followSystem(false)
	app.mu.Unlock()
	settle("Nord, not following", "dark", true)
	choose("Paper", false)
	settle("Paper, not following", "light", false)
}

func TestSidebarEdgeShowsTheSurfaceBesideIt(t *testing.T) {
	app, tt, _ := themedApp(t, "")
	for _, th := range []*chrome.Theme{chrome.Light, chrome.Dark} {
		app.mu.Lock()
		app.chooseTheme(th.Name, false)
		app.mu.Unlock()
		tt.Frame()
		grip, ok := tt.Find("sidebar-grip")
		edge, ok2 := tt.Find("sidebar-grip-edge")
		bar, ok3 := tt.Find("tab-bar")
		panes, ok4 := tt.Find("Panes")
		if !ok || !ok2 || !ok3 || !ok4 || edge.X != grip.X+grip.W || grip.W+edge.W != 5 {
			t.Fatalf("grip %v edge %v", grip, edge)
		}
		win, ok5 := tt.Find("window-chrome")
		if !ok5 || bar.Y < win.Y || bar.Y+bar.H > win.Y+win.H+0.5 || grip.Y != 0 || win.X < grip.X+grip.W-0.5 {
			t.Errorf("%s: comfortable tabs %v header %v grip %v", th.Name, bar, win, grip)
		}
		if panes.Y+1 < win.Y+win.H {
			t.Errorf("%s: panes %v overlap the header %v", th.Name, panes, win)
		}
	}
	for _, label := range []string{"sidebar-grip", "sidebar-grip-edge"} {
		side, _ := tt.Find("sidebar")
		r, _ := tt.Find(label)
		x, y := r.X+r.W/2, r.Y+r.H/2
		tt.Press(x, y)
		tt.Move(x+40, y)
		tt.Release(x+40, y)
		tt.Frame()
		if now, _ := tt.Find("sidebar"); now.W < side.W+39 || now.W > side.W+41 {
			t.Fatalf("dragging %s: sidebar %v → %v", label, side.W, now.W)
		}
	}
}

func contrast(a, b ui.Color) float64 {
	lum := func(c ui.Color) float64 {
		ch := func(v uint8) float64 {
			s := float64(v) / 255
			if s <= 0.04045 {
				return s / 12.92
			}
			return math.Pow((s+0.055)/1.055, 2.4)
		}
		return 0.2126*ch(c.R) + 0.7152*ch(c.G) + 0.0722*ch(c.B)
	}
	x, y := lum(a), lum(b)
	return (max(x, y) + 0.05) / (min(x, y) + 0.05)
}

func TestLightThemesWhiteTextReads(t *testing.T) {
	t.Run("indexed", func(t *testing.T) { whiteTextReads(t, 1<<24|7, 1<<24|15) })
	t.Run("named", func(t *testing.T) { whiteTextReads(t, 8, 16) })
}

func whiteTextReads(t *testing.T, white, brightWhite uint32) {
	a, f, tt, _ := themedCoreApp(t, t.TempDir())
	typeInto(a, "b")
	readyCorePane(t, a, tt, "b")
	w, b := "37", "97"
	if white>>24 == 1 && brightWhite>>24 == 1 {
		w, b = "38;5;7", "38;5;15"
	}
	v := coreOutput(t, a, f, tt, "b", fmt.Sprintf("\x1b[3;1H\x1b[%sm██\x1b[%sm██\x1b[0m\x1b[4;1H\x1b[%smls\x1b[%sm -\x1b[0m", w, b, w, b))
	coreAppAct(a, func() { a.followSystem(false) })
	for _, c := range []struct {
		name string
		w, b ui.Color
	}{{"Paper", ui.Hex("#474646"), ui.Hex("#2F2E2E")}, {"Newsprint", ui.Hex("#434340"), ui.Hex("#121211")}, {"Paper", ui.Hex("#474646"), ui.Hex("#2F2E2E")}} {
		coreAppAct(a, func() { a.chooseTheme(c.name, false) })
		tt.Frame()
		for x, want := range []ui.Color{c.w, c.w, c.b, c.b} {
			r := vtCell(t, tt, v, "b", x, 2)
			got := tt.Image().RGBAAt((r.Min.X+r.Max.X)/2, (r.Min.Y+r.Max.Y)/2)
			if !nearColor(got, want) || contrast(want, a.th.Terminal.Background) < 4.5 {
				t.Errorf("%s ANSI block %d=%v want %v with contrast>=4.5", c.name, x, got, want)
			}
		}
	}
}

func TestThemeSwitchChangesOnlyThemeColors(t *testing.T) {
	a, f, tt, _ := themedCoreApp(t, t.TempDir())
	typeInto(a, "b")
	readyCorePane(t, a, tt, "b")
	v := coreOutput(t, a, f, tt, "b", "\x1b[3;1H\x1b[37m█\x1b[38;5;1m█\x1b[38;5;196m█\x1b[38;5;244m█\x1b[38;2;255;136;0m█\x1b[0m\x1b[4;1H█\x1b[48;2;18;52;86m \x1b[0m \x1b[44m \x1b[48;5;21m \x1b[0m")
	coreAppAct(a, func() { a.followSystem(false) })

	draw := func(name string) (px []ui.Color) {
		a.mu.Lock()
		a.chooseTheme(name, false)
		a.mu.Unlock()
		tt.Frame()
		for y := 2; y <= 3; y++ {
			for x := range 5 {
				r := vtCell(t, tt, v, "b", x, y)
				c := tt.Image().RGBAAt((r.Min.X+r.Max.X)/2, (r.Min.Y+r.Max.Y)/2)
				px = append(px, ui.RGB(c.R, c.G, c.B))
			}
		}
		return px
	}
	cube196, gray244, blue21 := ui.RGB(255, 0, 0), ui.RGB(128, 128, 128), ui.RGB(0, 0, 255)
	want := func(th *terminal.Theme) []ui.Color {
		return []ui.Color{
			th.Palette[7], th.Palette[1], cube196, gray244, ui.Hex("#FF8800"),
			th.Foreground, ui.Hex("#123456"), th.Background, th.Palette[4], blue21,
		}
	}
	themeOwned := []bool{true, true, false, false, false, true, false, true, true, false}
	tvaTheme, _ := chrome.Builtin("TVA Control")
	lightTheme, _ := chrome.Builtin("TVA Light")
	paper, nord, tva, light := draw("Paper"), draw("Nord"), draw("TVA Control"), draw("TVA Light")
	for i := range paper {
		for _, c := range []struct {
			name string
			got  ui.Color
			want ui.Color
		}{{"Paper", paper[i], want(chrome.Light.Terminal)[i]}, {"Nord", nord[i], want(chrome.Dark.Terminal)[i]}, {"TVA Control", tva[i], want(tvaTheme.Terminal)[i]}, {"TVA Light", light[i], want(lightTheme.Terminal)[i]}} {
			if !nearColor(color.RGBA{c.got.R, c.got.G, c.got.B, 255}, c.want) {
				t.Errorf("%s cell %d is %v, want %v", c.name, i, c.got, c.want)
			}
		}
		if changed := paper[i] != nord[i]; changed != themeOwned[i] {
			t.Errorf("cell %d: Paper %v, Nord %v; theme-owned %v", i, paper[i], nord[i], themeOwned[i])
		}
		if changed := nord[i] != tva[i]; changed != themeOwned[i] {
			t.Errorf("cell %d: Nord %v, TVA Control %v; theme-owned %v", i, nord[i], tva[i], themeOwned[i])
		}
		if changed := tva[i] != light[i]; changed != themeOwned[i] {
			t.Errorf("cell %d: TVA Control %v, TVA Light %v; theme-owned %v", i, tva[i], light[i], themeOwned[i])
		}
	}
}

func TestTVAThemesRead(t *testing.T) {
	for name, dark := range map[string]bool{"TVA Control": true, "TVA Light": false} {
		th, ok := chrome.Builtin(name)
		if !ok || th.Dark != dark {
			t.Fatalf("%s is not a built-in of dark %v", name, dark)
		}
		tvaReads(t, th)
	}
}

func tvaReads(t *testing.T, th *chrome.Theme) {
	term, w := th.Terminal, th.Widget()
	over := func(c, under ui.Color) ui.Color {
		a := float64(c.A) / 255
		mix := func(x, y uint8) uint8 { return uint8(math.Round(float64(x)*(1-a) + float64(y)*a)) }
		return ui.RGB(mix(under.R, c.R), mix(under.G, c.G), mix(under.B, c.B))
	}
	for _, c := range []struct {
		what   string
		fg, bg ui.Color
		min    float64
	}{
		{"text", th.Foreground, th.Background, 7},
		{"row text", th.Row.Base.Foreground, th.Sidebar, 4.5},
		{"tertiary", th.Tertiary, th.Sidebar, 4.5},
		{"hover", th.Row.Hover.Foreground, th.Row.Hover.Background, 4.5},
		{"selected", th.Row.Active.Foreground, th.Row.Active.Background, 4.5},
		{"unfocused", th.Row.ActiveUnfocused.Foreground, th.Row.ActiveUnfocused.Background, 4.5},
		{"selected tab", th.Tab.Active.Foreground, th.Tab.Active.Background, 4.5},
		{"accent button", th.AccentForeground, th.Accent, 4.5},
		{"popup", th.Foreground, th.Surface, 4.5},
		{"selection inset", th.Row.Active.Border, th.Row.Active.Background, 3},
		{"working", th.Working, th.Sidebar, 3},
		{"blocked", th.Blocked, th.Sidebar, 3},
		{"done", th.Done, th.Sidebar, 3},
		{"terminal", term.Foreground, term.Background, 7},
		{"cursor", term.CursorText, term.Cursor, 4.5},
		{"cursor on bg", term.Cursor, term.Background, 3},
		{"selection", term.SelectionText, term.Selection, 4.5},
		{"field selection", th.Foreground, over(w.Selection, th.Background), 4.5},
		{"popup field selection", th.Foreground, over(w.Selection, th.Surface), 4.5},
		{"focus ring", over(w.Focus, th.Background), th.Background, 3},
		{"field focus ring", over(w.Focus, th.Surface), th.Surface, 3},
		{"focused field border", w.Accent, th.Surface, 3},
	} {
		if r := contrast(c.fg, c.bg); r < c.min {
			t.Errorf("%s %s: %v on %v is %.2f:1, want %.1f", th.Name, c.what, c.fg, c.bg, r, c.min)
		}
	}
	for i, p := range term.Palette {
		if r := contrast(p, term.Background); r < 4.5 {
			t.Errorf("%s ANSI %d %v on the background is %.2f:1", th.Name, i, p, r)
		}
	}
}

func TestTVALightFocusBesideStates(t *testing.T) {
	th, _ := chrome.Builtin("TVA Light")
	for what, bg := range map[string]ui.Color{
		"row hover": th.Row.Hover.Background, "tab hover": th.Tab.Hover.Background,
		"selected row": th.Row.Active.Background, "selected tab": th.Tab.Active.Background,
		"pressed": th.Widget().SurfacePressed, "hover": th.Widget().SurfaceHover,
	} {
		if th.Widget().Focus.A != 255 {
			t.Fatalf("focus %v is not opaque", th.Widget().Focus)
		}
		if r := contrast(th.Widget().Focus, bg); r < 3 {
			t.Errorf("focus ring beside %s %v is %.2f:1", what, bg, r)
		}
	}
}

func TestTVALightSelectionDraws(t *testing.T) {
	th, _ := chrome.Builtin("TVA Light")
	app, f, tt, _ := themedCoreApp(t, t.TempDir())
	coreAppAct(app, func() { app.followSystem(false); app.chooseTheme("TVA Light", false) })
	v := coreOutput(t, app, f, tt, "a", "\x1b[3;1H\x1b[34m█\x1b[0m  ")
	cell := func(x int) (float32, float32) {
		r := vtCell(t, tt, v, "a", x, 2)
		return float32(r.Min.X+r.Max.X) / 2, float32(r.Min.Y+r.Max.Y) / 2
	}
	px := func(x int) color.RGBA {
		cx, cy := cell(x)
		return tt.Image().RGBAAt(int(cx), int(cy))
	}
	if got := px(0); !nearColor(got, th.Terminal.Palette[4]) {
		t.Fatalf("the block before selecting is %v, want blue %v", got, th.Terminal.Palette[4])
	}
	tt.Press(cell(0))
	end := vtCell(t, tt, v, "a", 1, 2)
	tt.Move(float32(end.Max.X-1), float32(end.Min.Y+end.Dy()/2))
	tt.Release(float32(end.Max.X-1), float32(end.Min.Y+end.Dy()/2))
	tt.Frame()
	if got := px(0); !nearColor(got, th.Terminal.SelectionText) {
		t.Errorf("selected block %v, want the selection text %v", got, th.Terminal.SelectionText)
	}
	if got := px(1); !nearColor(got, th.Terminal.Selection) {
		t.Errorf("selected blank %v, want the selection %v", got, th.Terminal.Selection)
	}
	if got := px(2); nearColor(got, th.Terminal.Selection) {
		t.Errorf("unselected cell %v has the selection color", got)
	}
	shot(t, tt, "tva-light-selection")
}

func TestTVASwitchKeepsTheGrid(t *testing.T) {
	tva, _ := chrome.Builtin("TVA Control")
	tvaLight, _ := chrome.Builtin("TVA Light")
	dir := t.TempDir()
	app, f, tt, panes := themedCoreApp(t, dir)
	app.SetLook(terminal.Options{Theme: &terminal.Theme{Background: ui.Hex("#102030"), Foreground: ui.Hex("#eeeeee"), Cursor: ui.Hex("#33CC66")}, NoBlink: true})
	tt.Frame()
	coreOutput(t, app, f, tt, "a", "\x1b[1;2H \x1b[1;2H")
	first := corePaneGeometries(t, app, tt)
	view := app.coreViews["a"]
	inactive := func(th *chrome.Theme) {
		t.Helper()
		g := corePaneGeometries(t, app, tt)
		if !reflect.DeepEqual(g, first) || app.coreViews["a"] != view {
			t.Fatal("theme changed renderer/geometry")
		}
		b := g[1]
		x, y := panes.X+int(b.term.X+b.cw*2.5), panes.Y+int(b.term.Y+b.ch*2.5)
		want := th.Terminal.Background.Mix(th.Foreground, inactiveVeil)
		if got := tt.Image().RGBAAt(x, y); !nearColor(got, want) {
			t.Errorf("%s inactive=%v want %v", th.Name, got, want)
		}
	}
	choose := func(name string, dark bool) {
		app.mu.Lock()
		app.chooseTheme(name, dark)
		app.mu.Unlock()
		tt.Frame()
	}
	choose("TVA Light", false)
	choose("TVA Control", true)
	tt.SetDark(true)
	tt.Frame()
	look(t, app, tt, panes, tva)
	inactive(tva)
	shot(t, tt, "tva-control")
	if app.th != tva || !app.th.Dark {
		t.Fatalf("theme %q", app.th.Name)
	}
	tt.SetDark(false)
	tt.Frame()
	look(t, app, tt, panes, tvaLight)
	inactive(tvaLight)
	shot(t, tt, "tva-light")
	if app.th != tvaLight || app.th.Dark {
		t.Fatalf("theme %q", app.th.Name)
	}
	g := corePaneGeometries(t, app, tt)[0]
	cw, ch, a := g.cw, g.ch, g.term
	mid := func() color.RGBA { return tt.Image().RGBAAt(panes.X+int(a.X+cw*1.5), panes.Y+int(a.Y+ch*0.5)) }
	if got := mid(); !nearColor(got, tvaLight.Terminal.Cursor) {
		t.Errorf("focused cursor middle %v, want %v", got, tvaLight.Terminal.Cursor)
	}
	app.Focus(false)
	tt.SetFocused(false)
	tt.Frame()
	tt.Frame()
	pixel := func(x, y int) ui.Color {
		p := tt.Image().RGBAAt(x, y)
		return ui.RGB(p.R, p.G, p.B)
	}
	name, _ := tt.Find("reherdr")
	if got := mid(); !nearColor(got, tvaLight.Terminal.Background) {
		t.Errorf("unfocused cursor middle %v, want hollow %v", got, tvaLight.Terminal.Background)
	}
	if got := pixel(int(name.X)-24, int(name.Y+name.H/2)); got != tvaLight.Row.ActiveUnfocused.Background {
		t.Errorf("unfocused row %v, want %v", got, tvaLight.Row.ActiveUnfocused.Background)
	}
	other, _ := tt.Find("notes")
	tt.Move(other.X+4, other.Y+other.H/2)
	if got := pixel(int(other.X)-24, int(other.Y+other.H/2)); got != tvaLight.Row.Hover.Background {
		t.Errorf("hovered row %v, want %v", got, tvaLight.Row.Hover.Background)
	}
	bar, _ := tt.Find("tab/t")
	if got := pixel(int(bar.X+bar.W*0.7), int(bar.Y+bar.H/2)); got != tvaLight.Tab.ActiveUnfocused.Background {
		t.Errorf("unfocused tab %v, want %v", got, tvaLight.Tab.ActiveUnfocused.Background)
	}
	shot(t, tt, "tva-light-unfocused-hover")
	tt.Move(0, 300)
	app.Focus(true)
	tt.SetFocused(true)
	tt.Frame()
	if s, _ := chrome.LoadSettings(dir); s.Theme != "TVA Light" || s.ThemeDark != "TVA Control" || !s.FollowSystem {
		t.Fatalf("saved %+v", s)
	}
	again := NewApp("inert-settings")
	again.LoadThemes(dir)
	if again.theme(false) != tvaLight || again.theme(true) != tva {
		t.Fatalf("reloaded %q and %q", again.theme(false).Name, again.theme(true).Name)
	}
	app.mu.Lock()
	app.followSystem(false)
	app.mu.Unlock()
	for _, name := range []string{"Paper", "TVA Light", "Nord", "TVA Light", chrome.GhosttyName, "TVA Light", "TVA Control", "Nord", "TVA Control", chrome.GhosttyName, "TVA Control", "Paper"} {
		choose(name, false)
		app.mu.Lock()
		th := app.th
		app.mu.Unlock()
		if th.Name != name {
			t.Fatalf("theme %q, want %q", th.Name, name)
		}
		look(t, app, tt, panes, th)
		inactive(th)
	}
	if got := app.wantAppearance(); got != "light" {
		t.Fatalf("appearance %q after Paper", got)
	}
}
