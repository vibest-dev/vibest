package app

import (
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func TestMenuBarOmitsClose(t *testing.T) {
	theme := &mygo.MenuItem{Label: "Theme", Submenu: []*mygo.MenuItem{{Label: "Paper"}}}
	mac := menuBar(true, theme)
	items := mac.Items()
	if len(items) != 5 || items[0].Role != mygo.RoleAppMenu || items[1].Role != mygo.RoleEditMenu || items[2].Role != mygo.RoleViewMenu || items[3].Label != "Theme" || items[4].Role != mygo.RoleWindowMenu {
		t.Fatalf("darwin bar = %s", menuSummary(items))
	}
	other := menuBar(false, &mygo.MenuItem{Label: "Theme", Submenu: []*mygo.MenuItem{{Label: "Paper"}}}).Items()
	if len(other) != 1 || other[0].Label != "Theme" {
		t.Fatalf("non-darwin bar = %s", menuSummary(other))
	}
	for _, role := range []mygo.MenuRole{
		mygo.RoleAppMenu, mygo.RoleEditMenu, mygo.RoleViewMenu, mygo.RoleWindowMenu,
		mygo.RoleFileMenu, mygo.RoleClose, mygo.RoleQuit,
	} {
		if findRole(other, role) != nil {
			t.Errorf("non-darwin menu has %s", role)
		}
	}
	if steals, why := menuStealsClose(other); steals {
		t.Fatalf("non-darwin menu steals close via %s", why)
	}

	if runtime.GOOS == "darwin" {
		if steals, why := menuStealsClose(items); steals {
			t.Fatalf("menu steals close via %s\n%s", why, menuSummary(items))
		}
		quit := findRole(items, mygo.RoleQuit)
		if quit == nil || quit.Click != nil {
			t.Fatalf("Quit role = %#v, want the standard role with no custom handler", quit)
		}
		win := items[4].Submenu
		if len(win) != 4 || win[0].Role != mygo.RoleMinimize || win[1].Role != mygo.RoleZoom || win[2].Type != mygo.MenuItemSeparator || win[3].Role != mygo.RoleFront {
			t.Fatalf("Window submenu = %s", menuSummary(win))
		}
		if findRole(win, mygo.RoleClose) != nil {
			t.Fatal("Window role expanded to Close")
		}
	} else if findRole(mygo.NewMenu([]*mygo.MenuItem{{Role: mygo.RoleWindowMenu}}).Items(), mygo.RoleClose) == nil {
		t.Fatal("non-darwin Window role no longer includes Close; MenuBar can include it")
	}
	got := MenuBar(&mygo.MenuItem{Label: "Theme", Submenu: []*mygo.MenuItem{{Label: "Paper"}}}).Items()
	want := menuBar(runtime.GOOS == "darwin", &mygo.MenuItem{Label: "Theme", Submenu: []*mygo.MenuItem{{Label: "Paper"}}}).Items()
	if len(got) != len(want) {
		t.Fatalf("MenuBar length %d, want %d for %s", len(got), len(want), runtime.GOOS)
	}
	for i := range got {
		if got[i].Role != want[i].Role || got[i].Label != want[i].Label {
			t.Fatalf("MenuBar[%d] = %s %q, want %s %q", i, got[i].Role, got[i].Label, want[i].Role, want[i].Label)
		}
	}
}

func TestCloseChordsRouteToTheFocusedPaneAndTab(t *testing.T) {
	for _, scope := range []string{"pane", "tab"} {
		a, f, tt := coreActivityUI(t)
		coreAppAct(a, func() { a.ShowPane("b") })
		readyCorePane(t, a, tt, "b")
		mods := ui.Cmd
		if scope == "tab" {
			mods |= ui.Shift
		}
		tt.Key(mods, ui.KeyW)
		if a.dialog == nil || len(coreRequests(f, "terminal.kill")) != 0 {
			t.Fatal("close chord lost confirmation")
		}
		if err := tt.Click("Close"); err != nil {
			t.Fatal(err)
		}
		awaitCoreApp(t, a, func() bool { return !a.corePending && a.coreState.Layout.Pane("b") == nil })
		if scope == "pane" {
			if a.coreState.Layout.Pane("a") == nil || len(coreRequests(f, "terminal.kill")) != 1 {
				t.Fatal("pane chord closed sibling")
			}
		} else if a.coreState.Layout.Tab("t1") != nil || len(coreRequests(f, "terminal.kill")) != 2 {
			t.Fatal("tab chord closed wrong scope")
		}
		noCoreData(t, f)
		noLegacyNavigation(t, f)
	}
}

func TestCmdWWithNoFocusedPaneDoesNotClose(t *testing.T) {
	for _, offline := range []bool{false, true} {
		a, f := newCoreAppFixture(t)
		if offline {
			a = newChromeTestApp()
		}
		tt := ui.NewTester(a.View, 800, 600)
		tt.Frame()
		tt.Key(0, ui.KeyTab)
		tt.Key(ui.Cmd, ui.KeyW)
		tt.Key(ui.Cmd|ui.Shift, ui.KeyW)
		coreAppAct(a, func() {
			if a.dialog != nil || len(a.coreClosing) != 0 {
				t.Fatal("empty document offered a terminal close")
			}
		})
		if len(coreRequests(f, "terminal.kill"))+len(coreRequests(f, "doc.set"))+len(coreRequests(f, "terminal.run")) != 0 {
			t.Fatal("empty close mutated Core")
		}
		noCoreData(t, f)
	}
}

func menuStealsClose(items []*mygo.MenuItem) (bool, string) {
	var why string
	var walk func([]*mygo.MenuItem) bool
	walk = func(items []*mygo.MenuItem) bool {
		for _, it := range items {
			if it.Role == mygo.RoleClose || it.Role == mygo.RoleFileMenu {
				why = string(it.Role)
				return true
			}
			if acceleratorStealsW(it.Accelerator) {
				why = it.Accelerator
				return true
			}
			if walk(it.Submenu) {
				return true
			}
		}
		return false
	}
	return walk(items), why
}

func hasRole(items []*mygo.MenuItem, role mygo.MenuRole) bool {
	return findRole(items, role) != nil
}

func findRole(items []*mygo.MenuItem, role mygo.MenuRole) *mygo.MenuItem {
	for _, it := range items {
		if it.Role == role {
			return it
		}
		if found := findRole(it.Submenu, role); found != nil {
			return found
		}
	}
	return nil
}

func menuSummary(items []*mygo.MenuItem) string {
	var b strings.Builder
	var walk func([]*mygo.MenuItem, string)
	walk = func(items []*mygo.MenuItem, indent string) {
		for _, it := range items {
			b.WriteString(indent)
			b.WriteString(it.Label)
			if it.Role != "" {
				b.WriteString(" role=")
				b.WriteString(string(it.Role))
			}
			if it.Accelerator != "" {
				b.WriteString(" accel=")
				b.WriteString(it.Accelerator)
			}
			b.WriteByte('\n')
			walk(it.Submenu, indent+"  ")
		}
	}
	walk(items, "")
	return b.String()
}

func acceleratorStealsW(acc string) bool {
	acc = strings.ReplaceAll(acc, " ", "")
	if acc == "" {
		return false
	}
	parts := strings.Split(acc, "+")
	if !strings.EqualFold(parts[len(parts)-1], "w") {
		return false
	}
	for _, p := range parts[:len(parts)-1] {
		switch strings.ToLower(p) {
		case "cmd", "command", "super", "meta", "cmdorctrl", "ctrl", "control":
			return true
		}
	}
	return false
}

func TestThemeMenuBarIsTheSafeMenu(t *testing.T) {
	app, _, _ := themedApp(t, t.TempDir())
	bars := make(chan *mygo.Menu, 16)
	app.Attach(Host{SetMenu: func(m *mygo.Menu) { bars <- m }})
	app.mu.Lock()
	app.followSystem(false)
	app.chooseTheme("Nord", false)
	app.mu.Unlock()
	var bar *mygo.Menu
	for deadline := time.After(2 * time.Second); bar == nil || menuItem(bar, "Theme", "Nord") == nil || !menuItem(bar, "Theme", "Nord").Checked; {
		select {
		case bar = <-bars:
		case <-deadline:
			t.Fatal("the theme worker installed no menu bar for Nord")
		}
	}
	items := bar.Items()
	if steals, why := menuStealsClose(items); steals {
		t.Fatalf("installed menu steals close via %s\n%s", why, menuSummary(items))
	}
	want := menuBar(runtime.GOOS == "darwin", &mygo.MenuItem{Label: "Theme"}, &mygo.MenuItem{Label: "Pane Style"}).Items()
	if len(items) != len(want) {
		t.Fatalf("installed menu\n%s, want MenuBar's shape for %s", menuSummary(items), runtime.GOOS)
	}
	for i := range items {
		if items[i].Role != want[i].Role || items[i].Label != want[i].Label {
			t.Fatalf("installed menu[%d] = %s %q, want %s %q", i, items[i].Role, items[i].Label, want[i].Role, want[i].Label)
		}
	}

	app.mu.Lock()
	other := menuBar(false, app.themeBarMenu(), app.paneStyleBarMenu()).Items()
	mac := menuBar(true, app.themeBarMenu(), app.paneStyleBarMenu()).Items()
	app.mu.Unlock()
	if len(other) != 2 || other[0].Label != "Theme" || other[1].Label != "Pane Style" {
		t.Fatalf("non-darwin bar = %s", menuSummary(other))
	}
	var walk func([]*mygo.MenuItem)
	walk = func(items []*mygo.MenuItem) {
		for _, it := range items {
			if it.Role != "" || it.Accelerator != "" {
				t.Errorf("non-darwin Theme menu item %q has role %q accelerator %q", it.Label, it.Role, it.Accelerator)
			}
			walk(it.Submenu)
		}
	}
	walk(other)
	if hasRole(mac, mygo.RoleFileMenu) || hasRole(mac, mygo.RoleClose) {
		t.Fatalf("darwin bar has File or Close\n%s", menuSummary(mac))
	}
}
