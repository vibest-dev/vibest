package app

import (
	"image"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestMenuCornersStayInside(t *testing.T) {
	tt := ui.NewTester(cornerMenuView, 320, 280)
	tt.SetPreferences(ui.Preferences{ReduceMotion: true})
	w, h := float32(320), float32(280)
	for _, at := range [][2]float32{{2, 2}, {318, 2}, {2, 278}, {318, 278}} {
		tt.RightClickAt(at[0], at[1])
		r, ok := tt.Find("vibest-menu")
		if !ok {
			t.Fatalf("click at %v: menu is not shown", at)
		}
		if r.X < 8-1 || r.Y < 8-1 || r.X+r.W > w-8+1 || r.Y+r.H > h-8+1 {
			t.Fatalf("click at %v: menu %+v leaves the 8px inset of %vx%v", at, r, w, h)
		}
		if r.W < 160 || r.H < 28 {
			t.Fatalf("click at %v: menu %+v is not a card", at, r)
		}
		if menuRed(tt, r) < 0.95 {
			t.Fatalf("click at %v: reduced motion left the menu fading", at)
		}
		tt.Key(0, ui.KeyEscape)
		if tt.Menu() != nil {
			t.Fatal("Escape left the menu open")
		}
	}
}

func TestMenuDismissDoesNotActivateTheBackground(t *testing.T) {
	f := &menuFix{}
	tt := ui.NewTester(f.view, 400, 300)
	tt.RightClick("Row")
	if tt.Menu() == nil {
		t.Fatal("menu did not open")
	}
	r, ok := tt.Find("Background")
	if !ok {
		t.Fatal("no background button")
	}
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	if f.hits != 0 {
		t.Fatalf("the background ran %d times", f.hits)
	}
	if tt.Menu() != nil {
		t.Fatal("the press outside left the menu open")
	}
}

func TestMenuEscapeRestoresFocus(t *testing.T) {
	f := &menuFix{}
	tt := ui.NewTester(f.view, 400, 300)
	if err := tt.Click("Anchor"); err != nil {
		t.Fatal(err)
	}
	if !tt.Focused("Anchor") {
		t.Fatal("the anchor did not take focus")
	}
	tt.RightClick("Row")
	if tt.Menu() == nil || tt.Focused("Anchor") {
		t.Fatal("the menu did not take focus")
	}
	tt.Key(0, ui.KeyEscape)
	if tt.Menu() != nil {
		t.Fatal("Escape left the menu open")
	}
	if !tt.Focused("Anchor") {
		t.Fatal("focus did not return")
	}
}

func TestMenuDisabledItemDoesNotRun(t *testing.T) {
	f := &menuFix{}
	tt := ui.NewTester(f.view, 400, 300)
	tt.RightClick("Row")
	if err := tt.ChooseMenuItem("Go"); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("disabled item: %v", err)
	}
	if f.chosen != "" {
		t.Fatalf("disabled item ran %q", f.chosen)
	}
	tt.Key(0, ui.KeyDown)
	tt.Key(0, ui.KeyEnter)
	if f.chosen != "stay" {
		t.Fatalf("keyboard chose %q", f.chosen)
	}
}

func TestMenuEntrance(t *testing.T) {
	f := &menuFix{}
	tt := ui.NewTester(f.view, 400, 400)
	tt.RightClick("Row")
	y0, p0 := menuPose(t, tt)
	if math.Abs(float64(p0)) > 0.04 {
		t.Fatalf("at 0ms opacity %v", p0)
	}
	tt.Advance(85 * time.Millisecond)
	tt.Frame()
	y85, p85 := menuPose(t, tt)
	tt.Advance(85 * time.Millisecond)
	tt.Frame()
	y170, p170 := menuPose(t, tt)
	if math.Abs(float64(p170-1)) > 0.04 {
		t.Fatalf("at 170ms opacity %v", p170)
	}
	travel := func(y float32) float32 { return y170 - y }
	if math.Abs(float64(travel(y0)-8)) > 0.6 {
		t.Fatalf("at 0ms travel %v (y %v → %v)", travel(y0), y0, y170)
	}
	if math.Abs(float64(travel(y85)-8*(1-0.972))) > 0.45 {
		t.Fatalf("at 85ms travel %v opacity %v", travel(y85), p85)
	}
	if math.Abs(float64(p85-0.972)) > 0.04 {
		t.Fatalf("at 85ms opacity %v", p85)
	}
	if math.Abs(float64(travel(y170))) > 0.6 {
		t.Fatalf("at 170ms travel %v", travel(y170))
	}
}

func TestMenuTerminalAndTextOpenAtOnce(t *testing.T) {
	tt := ui.NewTester(instantMenuView, 400, 300)
	for _, name := range []string{"Terminal", "Field"} {
		if err := tt.RightClick(name); err != nil {
			t.Fatal(err)
		}
		r, p := menuPose(t, tt)
		tt.Advance(200 * time.Millisecond)
		tt.Frame()
		later, lp := menuPose(t, tt)
		if math.Abs(float64(p-1)) > 0.04 || math.Abs(float64(lp-1)) > 0.04 || math.Abs(float64(later-r)) > 0.6 {
			t.Fatalf("%s moved or faded: y %v→%v opacity %v→%v", name, r, later, p, lp)
		}
		tt.Key(0, ui.KeyEscape)
	}
}

func TestMenuSubmenuGap(t *testing.T) {
	tt := ui.NewTester(submenuGapView, 420, 300)
	tt.SetPreferences(ui.Preferences{ReduceMotion: true})
	if err := tt.RightClick("Row"); err != nil {
		t.Fatal(err)
	}
	tt.Key(0, ui.KeyDown)
	tt.Key(0, ui.KeyRight)
	parent, ok := tt.Find("vibest-menu")
	sub, okSub := tt.Find("vibest-submenu")
	if !ok || !okSub {
		t.Fatalf("cards parent %v submenu %v", ok, okSub)
	}
	gap := sub.X - (parent.X + parent.W)
	if math.Abs(float64(gap-menuSubmenuGap)) > 1 {
		t.Fatalf("submenu gap %v, want %v (parent %+v sub %+v)", gap, menuSubmenuGap, parent, sub)
	}
}

func TestMenuPointerGap(t *testing.T) {
	tt := ui.NewTester(pointerGapView, 420, 480)
	tt.SetPreferences(ui.Preferences{ReduceMotion: true})
	check := func(name string, gap float32) {
		t.Helper()
		r, ok := tt.Find(name)
		if !ok {
			t.Fatal(name)
		}
		x, y := r.X+r.W/2, r.Y+r.H/2
		tt.RightClickAt(x, y)
		menu, ok := tt.Find("vibest-menu")
		if !ok {
			t.Fatalf("%s: no menu", name)
		}
		if math.Abs(float64(menu.X-x)) > 1.5 || math.Abs(float64(menu.Y-(y+gap))) > 1.5 {
			t.Fatalf("%s: menu at %v,%v, click %v,%v, want gap %v", name, menu.X, menu.Y, x, y, gap)
		}
		tt.Key(0, ui.KeyEscape)
	}
	check("Row", 0)
	check("Terminal", menuAnchorGap)
	check("Field", menuAnchorGap)
}

func submenuGapView(c *ui.Context) {
	installMenuSkin(c)
	ui.Box(c).Fill().Background(c.Theme().Background).Children(func() {
		row := ui.Box(c).Size(80, 24).Absolute().Left(16).Top(16).Label("Row")
		row.ContextMenu(func(m *ui.Menu) {
			m.Submenu("More", func(m *ui.Menu) { m.Item("Inside") })
		})
	})
}

func pointerGapView(c *ui.Context) {
	installMenuSkin(c)
	ui.Box(c).Fill().Background(c.Theme().Background).Children(func() {
		ui.Box(c).Size(100, 28).Absolute().Left(24).Top(24).Label("Row").ContextMenu(func(m *ui.Menu) {
			m.Item("Stay")
		})
		ui.Box(c).Size(120, 28).Absolute().Left(24).Top(80).Label("Terminal").ContextMenu(func(m *ui.Menu) {
			m.Item("Copy")
		})
		text := "hello"
		ui.TextInput(c, &text).Width(160).Absolute().Left(24).Top(140).Label("Field")
	})
}

type menuFix struct {
	chosen string
	hits   int
}

func (f *menuFix) view(c *ui.Context) {
	installMenuSkin(c)
	ui.Box(c).Fill().Background(c.Theme().Background).Children(func() {
		ui.Button(c, "Anchor").Absolute().Left(8).Top(160)
		row := ui.Box(c).Size(80, 24).Absolute().Left(16).Top(16).Label("Row")
		row.ContextMenu(func(m *ui.Menu) {
			if m.Item("Go").Disabled(true).Chosen() {
				f.chosen = "go"
			}
			if m.Item("Stay").Chosen() {
				f.chosen = "stay"
			}
		})
		if ui.Button(c, "Background").Absolute().Right(8).Bottom(8).Clicked() {
			f.hits++
		}
	})
}

func cornerMenuView(c *ui.Context) {
	installMenuSkin(c)
	box := ui.Box(c).Fill().Background(c.Theme().Background).Label("Field")
	box.ContextMenu(func(m *ui.Menu) {
		for range 7 {
			m.Item("Reorder the workspace checkout")
		}
	})
}

func instantMenuView(c *ui.Context) {
	installMenuSkin(c)
	ui.Box(c).Fill().Background(c.Theme().Background).Children(func() {
		ui.Box(c).Size(120, 40).Absolute().Left(20).Top(20).Label("Terminal").ContextMenu(func(m *ui.Menu) {
			m.Item("Copy")
			m.Item("Paste")
		})
		text := "hello"
		ui.TextInput(c, &text).Width(160).Absolute().Left(20).Top(80).Label("Field")
	})
}

func installMenuSkin(c *ui.Context) {
	th := ui.LightTheme()
	th.Background = ui.RGB(0, 0, 0)
	th.Surface = ui.RGB(255, 0, 0)
	th.Text = ui.RGB(255, 255, 255)
	c.SetTheme(th)
	c.SetMenuPresentation(ui.PopoverMenus)
	skin := menuSkin(c)
	panel := skin.Panel
	skin.Panel = func(p ui.Element, info ui.MenuPaint) {
		panel(p, info)
		if info.Level == 0 {
			p.Label("vibest-menu")
		} else {
			p.Label("vibest-submenu")
		}
	}
	c.SetMenuPainter(skin)
}

func menuPose(t *testing.T, tt *ui.Tester) (float32, float32) {
	t.Helper()
	r, ok := tt.Find("vibest-menu")
	if !ok {
		t.Fatal("menu is not shown")
	}
	return r.Y, menuRed(tt, r)
}

func menuRed(tt *ui.Tester, r ui.Rect) float32 {
	img := tt.Image()
	x := int(r.X + r.W - 10)
	y := int(r.Y + 3)
	if img == nil || !image.Pt(x, y).In(img.Bounds()) {
		return -1
	}
	return float32(img.RGBAAt(x, y).R) / 255
}
