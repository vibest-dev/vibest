package app

import (
	"fmt"
	"log"
	"strings"
	"sync"

	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

type themes struct {
	dir         string
	settings    chrome.Settings
	light, dark *chrome.Theme
	note        string
}

func (a *App) LoadThemes(dir string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.themes.dir = dir
	s, err := chrome.LoadSettings(dir)
	a.themes.settings = s
	a.sidebarVisible = !s.SidebarHidden
	if s.SidebarWidth > 0 {
		a.sideWidth = s.SidebarWidth
	}
	a.resolveThemes()
	if err != nil {
		a.themes.note = "Theme settings could not be read (" + err.Error() + "); using the defaults."
		log.Println("herdr: theme settings:", err)
	}
}

func (a *App) resolveThemes() {
	var notes []string
	add := func(n string) {
		if n != "" {
			notes = append(notes, n)
		}
	}
	var n string
	a.themes.light, n = a.resolveTheme(a.themes.settings.Theme, false)
	add(n)
	a.themes.dark, n = a.resolveTheme(a.themes.settings.ThemeDark, true)
	if a.themes.settings.ThemeDark != a.themes.settings.Theme {
		add(n)
	}
	a.themes.note = strings.Join(notes, " ")
	a.syncNative()
	a.invalidate()
}

func (a *App) syncNative() {
	if a.native == nil {
		return
	}
	select {
	case a.native <- struct{}{}:
	default:
	}
}

func (a *App) nativeLoop(kick <-chan struct{}, h Host) {
	look, dark, first := "", false, true
	for range kick {
		a.mu.Lock()
		m, wantLook, wantDark := a.appMenu(), a.wantAppearance(), a.th.Dark
		a.mu.Unlock()
		if h.SetMenu != nil {
			h.SetMenu(m)
		}
		if h.SetAppearance != nil && (first || wantLook != look) {
			h.SetAppearance(wantLook)
		}
		if h.SetWindowDark != nil && (first || wantDark != dark) {
			h.SetWindowDark(wantDark)
		}
		look, dark, first = wantLook, wantDark, false
	}
}

func (a *App) resolveTheme(name string, dark bool) (*chrome.Theme, string) {
	fallback := chrome.Light
	if dark {
		fallback = chrome.Dark
	}
	if strings.EqualFold(name, chrome.GhosttyName) {
		term := a.look.Theme
		if dark && a.look.DarkTheme != nil {
			term = a.look.DarkTheme
		}
		if term == nil {
			return fallback, fmt.Sprintf("Ghostty has no theme set; using %s.", fallback.Name)
		}
		return chrome.Ghostty(term), ""
	}
	if t, ok := chrome.Builtin(name); ok {
		return t, ""
	}
	log.Printf("herdr: theme %q: not a built-in theme", name)
	return fallback, fmt.Sprintf("Theme %q is not a built-in theme. Using %s.", name, fallback.Name)
}

func (a *App) theme(systemDark bool) *chrome.Theme {
	if a.themes.light == nil {
		a.themes.light, a.themes.dark = chrome.Light, chrome.Dark
	}
	if a.themes.settings.FollowSystem && systemDark {
		return a.themes.dark
	}
	return a.themes.light
}

func (a *App) chooseTheme(name string, dark bool) {
	if dark {
		a.themes.settings.ThemeDark = name
	} else {
		a.themes.settings.Theme = name
	}
	a.saveThemes()
}

func (a *App) followSystem(on bool) {
	a.themes.settings.FollowSystem = on
	a.saveThemes()
}

func (a *App) saveThemes() {
	a.resolveThemes()
	a.saveSettings()
}

func (a *App) saveSettings() {
	if a.themes.dir == "" {
		return
	}
	if err := chrome.SaveSettings(a.themes.dir, a.themes.settings); err != nil {
		log.Println("herdr: save settings:", err)
		msg := "Settings could not be saved: " + err.Error()
		if !strings.Contains(a.themes.note, msg) {
			a.themes.note = strings.TrimSpace(a.themes.note + " " + msg)
		}
	}
}

func (a *App) wantAppearance() string {
	if a.themes.settings.FollowSystem {
		return "system"
	}
	if a.theme(false).Dark {
		return "dark"
	}
	return "light"
}

func (a *App) catalog() []string {
	out := append([]string{}, chrome.Builtins...)
	if a.look.Theme != nil || a.look.DarkTheme != nil {
		out = append(out, chrome.GhosttyName)
	}
	return out
}

type themeItem struct {
	label             string
	checked, disabled bool
	sub               []themeItem
	do                func()
}

func (a *App) themeItems() []themeItem {
	s := a.themes.settings
	names := a.catalog()
	list := func(current string, dark bool) []themeItem {
		var out []themeItem
		for _, name := range names {
			out = append(out, themeItem{label: name, checked: strings.EqualFold(name, current), do: func() { a.chooseTheme(name, dark) }})
		}
		return out
	}
	var items []themeItem
	if s.FollowSystem {
		items = append(items,
			themeItem{label: "Light Appearance", sub: list(s.Theme, false)},
			themeItem{label: "Dark Appearance", sub: list(s.ThemeDark, true)})
	} else {
		items = list(s.Theme, false)
	}
	return append(items,
		themeItem{},
		themeItem{label: "Follow System Appearance", checked: s.FollowSystem, do: func() { a.followSystem(!a.themes.settings.FollowSystem) }},
	)
}

func (a *App) themeMenu(m *ui.Menu) {
	var add func(m *ui.Menu, items []themeItem)
	add = func(m *ui.Menu, items []themeItem) {
		for _, it := range items {
			switch {
			case it.label == "":
				m.Separator()
			case it.sub != nil:
				m.Submenu(it.label, func(m *ui.Menu) { add(m, it.sub) })
			case m.Item(it.label).Checked(it.checked).Disabled(it.disabled).Chosen():
				it.do()
			}
		}
	}
	add(m, a.themeItems())
}

func (a *App) appMenu() *mygo.Menu {
	return MenuBar(a.themeBarMenu(), a.paneStyleBarMenu())
}

func (a *App) paneStyleBarMenu() *mygo.MenuItem {
	cur := a.paneStyle()
	item := func(label, style string) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Type: mygo.MenuItemCheckbox, Checked: cur == style, Click: func(*mygo.MenuItem, *mygo.Window) {
			a.mu.Lock()
			a.setPaneStyle(style)
			a.mu.Unlock()
		}}
	}
	return &mygo.MenuItem{Label: "Pane Style", Submenu: []*mygo.MenuItem{item("Comfortable", paneComfortable), item("Compact", paneCompact)}}
}

func (a *App) themeBarMenu() *mygo.MenuItem {
	var conv func(items []themeItem) []*mygo.MenuItem
	conv = func(items []themeItem) []*mygo.MenuItem {
		var out []*mygo.MenuItem
		for _, it := range items {
			switch {
			case it.label == "":
				out = append(out, mygo.Separator())
			case it.sub != nil:
				out = append(out, &mygo.MenuItem{Label: it.label, Submenu: conv(it.sub)})
			default:
				do := it.do
				out = append(out, &mygo.MenuItem{Label: it.label, Type: mygo.MenuItemCheckbox, Checked: it.checked, Disabled: it.disabled,
					Click: func(*mygo.MenuItem, *mygo.Window) {
						a.mu.Lock()
						do()
						a.mu.Unlock()
					}})
			}
		}
		return out
	}
	return &mygo.MenuItem{Label: "Theme", Submenu: conv(a.themeItems())}
}

func (a *App) paneLook(th *chrome.Theme) terminal.Options {
	look := a.look
	if fam := installedFamilies(th.FontMono); fam != "" {
		if look.Font.Family != "" {
			fam += "," + look.Font.Family
		}
		look.Font.Family = fam
	}
	if th.CellHeight > 0 {
		look.Font.LineHeight = th.CellHeight
	}
	return look
}

var (
	familiesOnce sync.Once
	families     map[string]bool
)

func installedFamilies(list string) string {
	if strings.TrimSpace(list) == "" {
		return ""
	}
	familiesOnce.Do(func() {
		families = map[string]bool{}
		for _, f := range ui.FontFamilies() {
			families[strings.ToLower(f.Name)] = true
		}
	})
	var out []string
	for _, f := range strings.Split(list, ",") {
		f = strings.Trim(strings.TrimSpace(f), `"'`)
		if f == "monospace" || families[strings.ToLower(f)] {
			out = append(out, f)
		}
	}
	return strings.Join(out, ",")
}
