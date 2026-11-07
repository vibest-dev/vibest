package app

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo/ui"
)

func slide(tt *ui.Tester) {
	tt.Advance(sidebarMotion.Duration + 20*time.Millisecond)
	tt.Frame()
}

func (a *App) toggleSidebarForTest() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.toggleSidebar()
}

func toggleApp(t *testing.T, w, h int, set ...func(*App)) (*App, *ui.Tester) {
	app, _, tt := coreShellFixture(t, w, h, 1, false, "single", set...)
	return app, tt
}

func toggle(t *testing.T, tt *ui.Tester, label string) {
	t.Helper()
	if err := tt.Click(label); err != nil {
		t.Fatalf("click %q: %v", label, err)
	}
	slide(tt)
}

func absent(t *testing.T, tt *ui.Tester, labels ...string) {
	t.Helper()
	for _, l := range labels {
		if _, ok := tt.Find(l); ok {
			t.Fatalf("%q is shown", l)
		}
	}
}

func toggleButton(t *testing.T, tt *ui.Tester, label string) ui.Rect {
	t.Helper()
	b := find(t, tt, label)
	if b.W != chrome.Light.IconButton || b.H != chrome.Light.IconButton {
		t.Fatalf("%q is %v, not an icon button", label, b)
	}
	return b
}

func saved(t *testing.T, dir string) chrome.Settings {
	t.Helper()
	s, err := chrome.LoadSettings(dir)
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	return s
}

func TestSidebarToggleClick(t *testing.T) {
	const winW = 1280
	app, tt := toggleApp(t, winW, 800)
	tt.Frame()

	sidebar, grip, col, panes := find(t, tt, "sidebar"), find(t, tt, "sidebar-grip"), find(t, tt, "main-column"), find(t, tt, "Panes")
	find(t, tt, "sidebar-grip-edge")
	toggleButton(t, tt, "Hide sidebar")
	absent(t, tt, "Show sidebar", "toggle-sidebar")
	if sidebar.X != 0 || sidebar.W < chrome.SidebarMin {
		t.Fatalf("sidebar %v", sidebar)
	}
	if grip.X != sidebar.X+sidebar.W || col.X != grip.X+grip.W || col.X+col.W != winW-outerPad {
		t.Fatalf("sidebar %v grip %v column %v", sidebar, grip, col)
	}
	if panes.X != col.X || panes.W != col.W {
		t.Fatalf("panes %v not the column %v", panes, col)
	}
	if !app.State().SidebarVisible {
		t.Fatal("State.SidebarVisible false while shown")
	}

	toggle(t, tt, "Hide sidebar")
	absent(t, tt, "sidebar", "sidebar-grip", "sidebar-grip-edge", "Hide sidebar")
	toggleButton(t, tt, "Show sidebar")
	if col, panes := find(t, tt, "main-column"), find(t, tt, "Panes"); col.X != sideGutter || col.W != winW-sideGutter-outerPad || panes.X != col.X || panes.W != mainPaneWidth(winW, sideGutter) {
		t.Fatalf("hidden: column %v panes %v, want the card inset by the gutter and margin", col, panes)
	}
	if _, ok := tt.Find("sidebar-gutter"); !ok {
		t.Fatal("hidden: no left gutter")
	}
	if app.State().SidebarVisible {
		t.Fatal("State.SidebarVisible true while hidden")
	}

	before := app.sideWidth
	tt.Press(1, 400)
	tt.Move(50, 400)
	tt.Release(50, 400)
	tt.Frame()
	if app.sideWidth != before {
		t.Fatalf("hidden grip dragged: width %v, was %v", app.sideWidth, before)
	}

	toggle(t, tt, "Show sidebar")
	find(t, tt, "sidebar-grip")
	find(t, tt, "sidebar-grip-edge")
	absent(t, tt, "Show sidebar")
	toggleButton(t, tt, "Hide sidebar")
	if back := find(t, tt, "sidebar"); back.W != sidebar.W {
		t.Fatalf("restored sidebar %v wide, want %v", back.W, sidebar.W)
	}
	if !app.State().SidebarVisible {
		t.Fatal("State.SidebarVisible false after restore")
	}
}

func TestSidebarToggleFocusAndInputContinuity(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
	v := a.coreViews["a"]
	for _, label := range []string{"Hide sidebar", "Show sidebar"} {
		toggle(t, tt, label)
		if !tt.TypeKeyNative(0, ui.KeyX, "x") {
			t.Fatal("toggle lost native owner")
		}
		wantCorePaneInput(t, f, "a", "x")
		if a.coreViews["a"] != v {
			t.Fatal("toggle replaced VT")
		}
	}
}

func TestSidebarToggleSplitPaneLayout(t *testing.T) {
	app, _, tt := coreShellFixture(t, 1280, 800, 1, false, "split")
	tt.Frame()
	before := find(t, tt, "Panes")

	toggle(t, tt, "Hide sidebar")
	after := find(t, tt, "Panes")
	if after.W <= before.W {
		t.Fatalf("panes did not widen: %v, was %v", after.W, before.W)
	}
	places := corePaneGeometries(t, app, tt)
	if len(places) < 2 {
		t.Fatalf("%d pane places, want 2", len(places))
	}
	p0, p1 := places[0], places[1]
	if p0.card.W <= 0 || p1.card.W <= 0 || p0.card.X+p0.card.W > p1.card.X+1 {
		t.Fatalf("cards %v and %v empty or overlapping", p0.card, p1.card)
	}

	toggle(t, tt, "Show sidebar")
	if back := find(t, tt, "Panes"); back.W != before.W {
		t.Fatalf("panes %v wide after restore, want %v", back.W, before.W)
	}
}

func TestSidebarToggleTitleBars(t *testing.T) {
	if float32(14+2*macTrafficLightY) != windowChromeMin {
		t.Fatalf("traffic lights at Y %v do not center on the %v window row", macTrafficLightY, windowChromeMin)
	}
	for _, tc := range []struct {
		name string
		bar  ui.TitleBar
	}{
		{"mac36", ui.TitleBar{Height: 36, Left: 78}},
		{"mac28", ui.TitleBar{Height: 28, Left: 78}},
		{"tall48", ui.TitleBar{Height: 48, Left: 78}},
		{"none", ui.TitleBar{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, tt := toggleApp(t, 1280, 800)
			tt.SetTitleBar(tc.bar)
			tt.Frame()
			btn := toggleButton(t, tt, "Hide sidebar")
			chromeH := max(windowChromeMin, tc.bar.Height)
			wantY := (max(tabBarHeight, tc.bar.Height) - chrome.Light.IconButton) / 2
			if btn.X != tc.bar.Left+chrome.Step8 || btn.Y != wantY {
				t.Fatalf("toggle at (%v, %v), want (%v, %v)", btn.X, btn.Y, tc.bar.Left+chrome.Step8, wantY)
			}
			win := find(t, tt, "window-chrome")
			side := find(t, tt, "sidebar")
			if win.Y != 0 || win.H != chromeH || win.X != side.X+side.W+3 {
				t.Fatalf("window row %v sidebar %v, want the header beside the sidebar, %v tall", win, side, chromeH)
			}
			bar, panes := find(t, tt, "tab-bar"), find(t, tt, "Panes")
			if !nearDip(bar.Y, win.Y) || !nearDip(bar.Y+bar.H, win.Y+win.H) {
				t.Fatalf("tab band %v is not the window row %v", bar, win)
			}
			tab := find(t, tt, "tab/t")
			if panes.Y < tab.Y+tab.H-0.5 || !near1(panes.Y-(tab.Y+tab.H), outerPad, 0.5) {
				t.Fatalf("panes %v are not %v under the tab %v", panes, outerPad, tab)
			}
			if tab.X < bar.X || tab.Y < win.Y || tab.Y+tab.H > win.Y+win.H+0.5 {
				t.Fatalf("tab %v outside the header %v", tab, win)
			}

			toggle(t, tt, "Hide sidebar")
			absent(t, tt, "Hide sidebar")
			if b := toggleButton(t, tt, "Show sidebar"); b.X != btn.X || b.Y != btn.Y {
				t.Fatalf("hidden: toggle at %v, was %v", b, btn)
			}
			create := find(t, tt, "new-workspace")
			tab = find(t, tt, "tab/t")
			if tab.Y < win.Y || tab.Y+tab.H > win.Y+win.H+0.5 || tab.X < create.X+create.W {
				t.Fatalf("hidden: tab %v overlaps the header controls %v or leaves the row %v", tab, create, win)
			}
			hb, hp := find(t, tt, "tab-bar"), find(t, tt, "Panes")
			if hb.H != bar.H || hp.Y != panes.Y || hp.H != panes.H || hp.W <= panes.W {
				t.Fatalf("hidden: tab row %v panes %v, was %v %v", hb, hp, bar, panes)
			}

			toggle(t, tt, "Show sidebar")
			if b := toggleButton(t, tt, "Hide sidebar"); b.X != btn.X || b.Y != btn.Y {
				t.Fatalf("restored: toggle at %v, was %v", b, btn)
			}
			if rb, rp := find(t, tt, "tab-bar"), find(t, tt, "Panes"); rb.H != bar.H || rp != panes {
				t.Fatalf("restored: tab row %v panes %v, was %v %v", rb, rp, bar, panes)
			}
		})
	}
}

func TestSidebarToggleEmptyAndNarrowWindows(t *testing.T) {
	t.Run("disconnected", func(t *testing.T) {
		_, _, tt := coreShellFixture(t, 800, 600, 1, false, "")
		tt.Frame()
		toggleButton(t, tt, "Hide sidebar")
		toggle(t, tt, "Hide sidebar")
		absent(t, tt, "sidebar")
	})
	t.Run("narrow", func(t *testing.T) {
		_, tt := toggleApp(t, 1280, 400)
		tt.SetSize(300, 400)
		tt.Frame()
		if b := find(t, tt, "Hide sidebar"); b.X+b.W > 300 {
			t.Fatalf("toggle %v past the 300 wide window", b)
		}
	})
}

func TestSidebarToggleScalesAndThemes(t *testing.T) {
	for _, scale := range []float32{1, 1.5, 2} {
		for _, dark := range []bool{false, true} {
			t.Run(fmt.Sprintf("scale%v-dark%v", scale, dark), func(t *testing.T) {
				_, tt := toggleApp(t, 1280, 800)
				tt.SetScale(scale)
				tt.SetDark(dark)
				tt.Frame()
				before := find(t, tt, "sidebar")

				toggle(t, tt, "Hide sidebar")
				absent(t, tt, "sidebar")
				if panes := find(t, tt, "Panes"); panes.X != sideGutter || panes.W != mainPaneWidth(1280, sideGutter) {
					t.Fatalf("hidden: panes %v, want x %v w %v", panes, sideGutter, mainPaneWidth(1280, sideGutter))
				}

				toggle(t, tt, "Show sidebar")
				if after := find(t, tt, "sidebar"); after.W != before.W {
					t.Fatalf("restored sidebar %v, was %v", after, before)
				}
			})
		}
	}
}

func TestSidebarToggleRepeatedConvergence(t *testing.T) {
	app, tt := toggleApp(t, 1280, 800)
	tt.Frame()
	for i := range 6 {
		label := "Hide sidebar"
		if !app.sidebarVisible {
			label = "Show sidebar"
		}
		was := app.sidebarVisible
		toggle(t, tt, label)
		if app.sidebarVisible == was {
			t.Fatalf("step %d: visibility did not turn", i)
		}

		tt.Frame()
		panes := find(t, tt, "Panes")
		openW := mainPaneWidth(1280, onPixel(app.sideWidth+3, 1))
		if app.sidebarVisible && panes.W != openW || !app.sidebarVisible && (panes.X != sideGutter || panes.W != mainPaneWidth(1280, sideGutter)) {
			t.Fatalf("step %d: visible %v, panes %v", i, app.sidebarVisible, panes)
		}
	}
	if !app.sidebarVisible {
		t.Fatal("hidden after an even number of toggles")
	}
	find(t, tt, "sidebar")
}

func TestSidebarTogglePersistence(t *testing.T) {
	dir := t.TempDir()
	app1 := NewApp("inert-settings-fixture")
	app1.LoadThemes(dir)
	if !app1.sidebarVisible {
		t.Fatal("hidden by default")
	}
	app1.toggleSidebarForTest()
	if s := saved(t, dir); app1.sidebarVisible || !s.SidebarHidden {
		t.Fatalf("toggled: visible %v, saved %+v", app1.sidebarVisible, s)
	}

	app2 := NewApp("inert-settings-fixture")
	app2.LoadThemes(dir)
	if app2.sidebarVisible {
		t.Fatal("app2 did not load hidden")
	}
	app2.sideWidth = 265
	app2.toggleSidebarForTest()
	if s := saved(t, dir); !app2.sidebarVisible || s.SidebarHidden || s.SidebarWidth != 265 {
		t.Fatalf("toggled back: visible %v, saved %+v", app2.sidebarVisible, s)
	}
	app3 := NewApp("inert-settings-fixture")
	app3.LoadThemes(dir)
	if !app3.sidebarVisible || app3.sideWidth != 265 {
		t.Fatalf("app3: visible %v width %v, want true 265", app3.sidebarVisible, app3.sideWidth)
	}

	oldDir := t.TempDir()
	oldJSON := `{"theme": "Paper", "theme_dark": "Nord", "follow_system": true}`
	if err := os.WriteFile(filepath.Join(oldDir, "settings.json"), []byte(oldJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	appOld := NewApp("inert-settings-fixture")
	appOld.LoadThemes(oldDir)
	if !appOld.sidebarVisible || appOld.sideWidth != chrome.SidebarWidth {
		t.Fatalf("legacy: visible %v width %v, want true %v", appOld.sidebarVisible, appOld.sideWidth, chrome.SidebarWidth)
	}
}

func TestSidebarToggleCustomWidthPreservedAcrossHiddenResize(t *testing.T) {
	dir := t.TempDir()
	app, tt := toggleApp(t, 1280, 800)
	app.LoadThemes(dir)
	coreAppAct(app, func() { app.sideWidth = 350 })
	tt.Frame()
	if w := find(t, tt, "sidebar").W; w != 350 {
		t.Fatalf("sidebar %v wide, want 350", w)
	}

	toggle(t, tt, "Hide sidebar")
	if s := saved(t, dir); app.State().SidebarVisible || !s.SidebarHidden || s.SidebarWidth != 350 {
		t.Fatalf("hidden: visible %v, saved %+v", app.State().SidebarVisible, s)
	}

	tt.SetSize(600, 800)
	tt.Frame()
	if s := saved(t, dir); app.sideWidth != 350 || s.SidebarWidth != 350 {
		t.Fatalf("hidden at 600: width %v, saved %v, want 350", app.sideWidth, s.SidebarWidth)
	}
	tt.SetSize(1280, 800)
	tt.Frame()
	if app.sideWidth != 350 {
		t.Fatalf("hidden at 1280: width %v, want 350", app.sideWidth)
	}

	toggle(t, tt, "Show sidebar")
	if w, s := find(t, tt, "sidebar").W, saved(t, dir); w != 350 || app.sideWidth != 350 || s.SidebarHidden || s.SidebarWidth != 350 {
		t.Fatalf("restored: sidebar %v width %v, saved %+v", w, app.sideWidth, s)
	}

	tt.SetSize(600, 800)
	tt.Frame()
	side, col := find(t, tt, "sidebar"), find(t, tt, "main-column")
	if side.W != clampSidebar(350, 600) || side.W+col.W > 600 {
		t.Fatalf("shown at 600: sidebar %v column %v, want %v wide and fitting", side.W, col.W, clampSidebar(350, 600))
	}
}

func TestSidebarSettingsSaveFailure(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(dir, []byte("blocker"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, tt := toggleApp(t, 1280, 800, func(a *App) {
		a.themes.dir = dir
		a.themes.settings.Theme = "Paper"
		a.themes.settings.ThemeDark = "Nord"
		a.themes.settings.FollowSystem = true
	})

	app.toggleSidebarForTest()
	if app.sidebarVisible || !app.themes.settings.SidebarHidden {
		t.Fatalf("visible %v, settings %+v", app.sidebarVisible, app.themes.settings)
	}
	if s := app.themes.settings; s.Theme != "Paper" || s.ThemeDark != "Nord" || !s.FollowSystem {
		t.Fatalf("theme choice changed: %+v", s)
	}
	if !strings.Contains(app.themes.note, "Settings could not be saved:") {
		t.Fatalf("note %q", app.themes.note)
	}
	note := app.themes.note
	app.toggleSidebarForTest()
	if app.themes.note != note {
		t.Fatalf("note grew to %q from %q", app.themes.note, note)
	}

	tt.Frame()
	grip := find(t, tt, "sidebar-grip")
	app.themes.note = ""
	before := app.sideWidth
	tt.Press(grip.X+1, grip.Y+100)
	tt.Move(grip.X+21, grip.Y+100)
	tt.Release(grip.X+21, grip.Y+100)
	tt.Frame()
	if app.sideWidth == before || app.themes.settings.SidebarWidth != app.sideWidth {
		t.Fatalf("grip: width %v (was %v), settings %v", app.sideWidth, before, app.themes.settings.SidebarWidth)
	}
	if !strings.Contains(app.themes.note, "Settings could not be saved:") {
		t.Fatalf("grip: note %q", app.themes.note)
	}
}

func TestSidebarToggleIcon(t *testing.T) {
	_, tt := toggleApp(t, 1280, 800)
	tt.SetScale(2)
	tt.Frame()
	inked := func(label string, x0, y0, x1, y1 float32) bool {
		t.Helper()
		b := toggleButton(t, tt, label)
		img := tt.Image()
		const scale = 2
		size := chrome.Light.Icon
		u := size / 16 * scale
		ox, oy := (b.X+(b.W-size)/2)*scale, (b.Y+(b.H-size)/2)*scale
		bg := img.RGBAAt(int((b.X+2)*scale), int((b.Y+b.H/2)*scale))
		for y := int(oy + y0*u); y < int(oy+y1*u); y++ {
			for x := int(ox + x0*u); x < int(ox+x1*u); x++ {
				p := img.RGBAAt(x, y)
				if d := int(p.R) - int(bg.R); d > 40 || d < -40 {
					return true
				}
			}
		}
		return false
	}
	if !inked("Hide sidebar", 5, 3.8, 7, 4.6) {
		t.Fatal("shown: no full-height divider under the top edge")
	}
	toggle(t, tt, "Hide sidebar")
	if inked("Show sidebar", 4, 3.8, 7, 4.6) {
		t.Fatal("hidden: the bar reaches the top edge")
	}
	if !inked("Show sidebar", 4.4, 7, 5.6, 9) {
		t.Fatal("hidden: no short bar")
	}
}

func TestSidebarCmdB(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
	width := find(t, tt, "sidebar").W
	tt.Key(ui.Ctrl, ui.KeyB)
	slide(tt)
	find(t, tt, "sidebar")
	wantCorePaneInput(t, f, "a", "\x02")
	if runtime.GOOS != "darwin" {
		return
	}
	tt.Key(ui.Cmd, ui.KeyB)
	slide(tt)
	absent(t, tt, "sidebar")
	toggleButton(t, tt, "Show sidebar")
	tt.Type("x")
	wantCorePaneInput(t, f, "a", "x")
	noCoreData(t, f)
	tt.Key(ui.Cmd, ui.KeyB)
	slide(tt)
	if find(t, tt, "sidebar").W != width || !a.State().SidebarVisible {
		t.Fatal("shortcut failed to restore sidebar")
	}
	_, _, empty := coreShellFixture(t, 800, 600, 1, false, "")
	empty.Key(ui.Cmd, ui.KeyB)
	slide(empty)
	absent(t, empty, "sidebar")
}
