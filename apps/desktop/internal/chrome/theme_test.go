package chrome

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

func TestBuiltinsAreComplete(t *testing.T) {
	newsprint, ok := Builtin("Newsprint")
	if !ok {
		t.Fatal("Newsprint missing")
	}
	for _, th := range []*Theme{Light, newsprint, Dark, tvaTheme, tvaLightTheme} {
		if th.Dark != (th == Dark || th == tvaTheme) {
			t.Errorf("%s dark = %v", th.Name, th.Dark)
		}
		for name, c := range map[string]ui.Color{
			"background": th.Background, "surface": th.Surface, "sidebar": th.Sidebar, "border": th.Border,
			"terminal": th.Terminal.Background, "container": th.Container.Background, "divider": th.Divider,
			"tab bar": th.TabBar, "foreground": th.Foreground, "row hover": th.Row.Hover.Background,
			"row active": th.Row.Active.Background, "tab active": th.Tab.Active.Background,
		} {
			if c.A != 255 {
				t.Errorf("%s %s = %v, want opaque", th.Name, name, c)
			}
		}
		if th.FontSize != 13 || th.FontSizeSmall != 11 {
			t.Errorf("%s sizes %v %v", th.Name, th.FontSize, th.FontSizeSmall)
		}
		if th.FontUI != "system-ui" {
			t.Errorf("%s font %q", th.Name, th.FontUI)
		}
		if len(th.Row.ActiveUnfocused.Shadows) != 0 || len(th.Tab.ActiveUnfocused.Shadows) != 0 {
			t.Errorf("%s unfocused state keeps its shadow", th.Name)
		}
		if th.Tab.Active.Background != th.Row.Active.Background || th.Tab.Active.Foreground != th.Row.Active.Foreground {
			t.Errorf("%s tab %+v, want the row's %+v", th.Name, th.Tab.Active, th.Row.Active)
		}
		if th.Widget() == nil || th.Widget().FontSize != 13 || th.Widget().Dark != th.Dark {
			t.Errorf("%s widget %+v", th.Name, th.Widget())
		}
		focus := th.Accent.Alpha(0.55)
		if th == tvaLightTheme {
			focus = th.Accent
		}
		if th.Widget().Focus != focus {
			t.Errorf("%s focus %v, want %v", th.Name, th.Widget().Focus, focus)
		}
	}
	if Light.Terminal == Dark.Terminal || newsprint.FontMono != "Office Code Pro" {
		t.Fatal("light and dark share a terminal theme, or Newsprint lost its font")
	}
	if len(Light.Row.Active.Shadows) != 1 || Light.Row.Active.Shadows[0].Color.A != 5 || Light.Tab.Active.Shadows[0].Color.A != 15 {
		t.Fatalf("Paper shadows %+v %+v", Light.Row.Active.Shadows, Light.Tab.Active.Shadows)
	}
	if len(newsprint.Row.Active.Shadows) != 0 || newsprint.Tab.Active.Shadows[0].Color.A != 13 {
		t.Fatalf("Newsprint shadows %+v %+v", newsprint.Row.Active.Shadows, newsprint.Tab.Active.Shadows)
	}
	if Dark.Row.Active.Shadows[0].Color.A != 64 || Dark.Shadows[0].Blur != 24 {
		t.Fatalf("Nord shadows %+v %+v", Dark.Shadows, Dark.Row.Active.Shadows)
	}
}

func TestBuiltinColorRoles(t *testing.T) {
	newsprint, _ := Builtin("Newsprint")
	nordBg := ui.Hex("#2E3440")
	for _, c := range []struct {
		th   *Theme
		role string
		got  ui.Color
		want ui.Color
	}{
		{Light, "terminal", Light.Terminal.Background, ui.Hex("#FCFBF9")},
		{Light, "terminal text", Light.Terminal.Foreground, ui.Hex("#1A1A1A")},
		{Light, "sidebar", Light.Sidebar, ui.Hex("#F5F4F0")},
		{Light, "tab bar", Light.TabBar, ui.Hex("#F5F4F0")},
		{Light, "border", Light.Border, ui.Hex("#E0DFD5")},
		{Light, "sidebar border", Light.SidebarBorder, ui.Hex("#E0DFD5")},
		{Light, "row text", Light.Row.Base.Foreground, ui.Hex("#8C8A80")},
		{Light, "row hover", Light.Row.Hover.Background, ui.Hex("#EBEAE5")},
		{Light, "selected card", Light.Row.Active.Background, ui.Hex("#FFFFFF")},
		{Light, "selected text", Light.Row.Active.Foreground, ui.Hex("#1A1A1A")},
		{Light, "selected border", Light.Row.Active.Border, ui.Hex("#E0DFD5")},
		{Light, "container", Light.Container.Background, ui.Hex("#FCFBF9")},
		{Light, "ANSI 7", Light.Terminal.Palette[7], ui.Hex("#474646")},
		{Light, "ANSI 15", Light.Terminal.Palette[15], ui.Hex("#2F2E2E")},
		{Light, "ANSI 6", Light.Terminal.Palette[6], ui.Hex("#3A7A6A")},
		{Light, "tertiary", Light.Tertiary, ui.Hex("#C1BEB5")},
		{newsprint, "ANSI 7", newsprint.Terminal.Palette[7], ui.Hex("#434340")},
		{newsprint, "ANSI 15", newsprint.Terminal.Palette[15], ui.Hex("#121211")},
		{newsprint, "ANSI 8", newsprint.Terminal.Palette[8], ui.Hex("#7A766B")},
		{newsprint, "terminal", newsprint.Terminal.Background, ui.Hex("#F4F4F1")},
		{newsprint, "sidebar", newsprint.Sidebar, ui.Hex("#F4F4F1")},
		{newsprint, "tab bar", newsprint.TabBar, ui.Hex("#F3F2EE")},
		{newsprint, "border", newsprint.Border, ui.Hex("#DBD6C8")},
		{newsprint, "row hover", newsprint.Row.Hover.Background, ui.Hex("#DFDDD5")},
		{newsprint, "tab hover", newsprint.Tab.Hover.Background, ui.Hex("#DFDCD3")},
		{newsprint, "selected card", newsprint.Row.Active.Background, ui.Hex("#6D7478")},
		{newsprint, "selected text", newsprint.Row.Active.Foreground, ui.Hex("#FFFFFF")},
		{Dark, "terminal", Dark.Terminal.Background, nordBg},
		{Dark, "terminal text", Dark.Terminal.Foreground, ui.Hex("#F1F6FF")},
		{Dark, "sidebar", Dark.Sidebar, nordBg},
		{Dark, "tab bar", Dark.TabBar, nordBg},
		{Dark, "border", Dark.Border, ui.Hex("#3A404B")},
		{Dark, "sidebar border", Dark.SidebarBorder, ui.Hex("#434C5E")},
		{Dark, "divider", Dark.Divider, ui.Hex("#3E444F")},
		{Dark, "row text", Dark.Row.Base.Foreground, ui.Hex("#C0C7D3")},
		{Dark, "row hover", Dark.Row.Hover.Background, ui.Hex("#393E4A")},
		{Dark, "selected card", Dark.Row.Active.Background, ui.Hex("#3B4252")},
		{Dark, "selected text", Dark.Row.Active.Foreground, ui.Hex("#ECEFF4")},
		{Dark, "unfocused text", Dark.Row.ActiveUnfocused.Foreground, ui.Hex("#C0C7D3")},
		{tvaTheme, "terminal", tvaTheme.Terminal.Background, ui.Hex("#211D19")},
		{tvaTheme, "terminal text", tvaTheme.Terminal.Foreground, ui.Hex("#EAD9B9")},
		{tvaTheme, "sidebar", tvaTheme.Sidebar, ui.Hex("#211D19")},
		{tvaTheme, "tab bar", tvaTheme.TabBar, ui.Hex("#211D19")},
		{tvaTheme, "container", tvaTheme.Container.Background, ui.Hex("#211D19")},
		{tvaTheme, "surface", tvaTheme.Surface, ui.Hex("#302922")},
		{tvaTheme, "divider", tvaTheme.Divider, ui.Hex("#64533F")},
		{tvaTheme, "accent", tvaTheme.Accent, ui.Hex("#F0A04B")},
		{tvaTheme, "row hover", tvaTheme.Row.Hover.Background, ui.Hex("#302922")},
		{tvaTheme, "selected card", tvaTheme.Row.Active.Background, ui.Hex("#493627")},
		{tvaTheme, "selected inset", tvaTheme.Row.Active.Border, ui.Hex("#F0A04B")},
		{tvaTheme, "unfocused card", tvaTheme.Row.ActiveUnfocused.Background, ui.Hex("#382F27")},
		{tvaTheme, "unfocused text", tvaTheme.Row.ActiveUnfocused.Foreground, ui.Hex("#C0AA8B")},
		{tvaTheme, "cursor", tvaTheme.Terminal.Cursor, ui.Hex("#F0A04B")},
		{tvaTheme, "selection", tvaTheme.Terminal.Selection, ui.Hex("#E3B66B")},
		{tvaTheme, "selection text", tvaTheme.Terminal.SelectionText, ui.Hex("#211D19")},
	} {
		if c.got != c.want {
			t.Errorf("%s %s = %v, want %v", c.th.Name, c.role, c.got, c.want)
		}
	}
	paper := [16]string{
		"#1A1A1A", "#A33A3A", "#2B5A38", "#A85A20", "#4A7A8A", "#4A3A6A", "#3A7A6A", "#474646",
		"#8C8A80", "#C36A6A", "#6B9A78", "#C88A50", "#7A9AAA", "#8A7A9A", "#6ABAAA", "#2F2E2E",
	}
	nord := [16]string{
		"#3B4252", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#88C0D0", "#E5E9F0",
		"#4C566A", "#BF616A", "#A3BE8C", "#EBCB8B", "#81A1C1", "#B48EAD", "#8FBCBB", "#ECEFF4",
	}
	ink := [16]string{
		"#262522", "#A33A35", "#5C7A3E", "#967927", "#2F5F8A", "#904180", "#3E7A78", "#434340",
		"#7A766B", "#C25852", "#7A9A52", "#D4A945", "#4470A0", "#BE79BB", "#739797", "#121211",
	}
	tva := [16]string{
		"#9F8A72", "#E88C76", "#B2BB78", "#E3B66B", "#8EADBC", "#C79DAD", "#91B6A4", "#DFCEB1",
		"#B6A18A", "#FFA08A", "#CAD390", "#FFD089", "#AACBD8", "#DFB8C9", "#ADD6C2", "#FFF0D3",
	}
	for _, set := range []struct {
		name string
		got  [16]ui.Color
		want [16]string
	}{
		{"TVA Control", tvaTheme.Terminal.Palette, tva},
		{"Paper", Light.Terminal.Palette, paper},
		{"Nord", Dark.Terminal.Palette, nord},
		{"Newsprint", newsprint.Terminal.Palette, ink},
	} {
		for i, h := range set.want {
			if set.got[i] != ui.Hex(h) {
				t.Errorf("%s palette[%d] = %v, want %s", set.name, i, set.got[i], h)
			}
		}
	}
}

func TestTVALightPaperPalette(t *testing.T) {
	th, _ := Builtin("TVA Light")
	for _, role := range []struct {
		name string
		got  ui.Color
		want string
	}{
		{"window", th.Background, "#F3F2EF"},
		{"sidebar", th.Sidebar, "#F3F2EF"},
		{"tab strip", th.TabBar, "#F3F2EF"},
		{"popup", th.Surface, "#FAF9F6"},
		{"container", th.Container.Background, "#FAF9F6"},
		{"terminal", th.Terminal.Background, "#FAF9F6"},
		{"row hover", th.Row.Hover.Background, "#EAE8E3"},
		{"tab hover", th.Tab.Hover.Background, "#EAE8E3"},
		{"selected row", th.Row.Active.Background, "#E6E4DF"},
		{"selected tab", th.Tab.Active.Background, "#E6E4DF"},
		{"unfocused row", th.Row.ActiveUnfocused.Background, "#ECEAE5"},
		{"unfocused tab", th.Tab.ActiveUnfocused.Background, "#ECEAE5"},
		{"border", th.Border, "#CCC8C0"},
		{"sidebar border", th.SidebarBorder, "#CCC8C0"},
		{"divider", th.Divider, "#CCC8C0"},
		{"unfocused row edge", th.Row.ActiveUnfocused.Border, "#817C73"},
		{"unfocused tab edge", th.Tab.ActiveUnfocused.Border, "#817C73"},
		{"terminal selection", th.Terminal.Selection, "#DDD9D0"},
		{"cursor text", th.Terminal.CursorText, "#FAF9F6"},
		{"accent text", th.AccentForeground, "#FAF9F6"},
	} {
		if role.got != ui.Hex(role.want) {
			t.Errorf("%s = %v, want %s", role.name, role.got, role.want)
		}
	}
}

func TestUnknownNameIsNotATheme(t *testing.T) {
	if _, ok := Builtin("Gone"); ok {
		t.Fatal("an unknown name resolved")
	}
	if th, ok := Builtin("paper"); !ok || th != Light {
		t.Fatal("Paper lookup is case-sensitive or missing")
	}
	if th, ok := Builtin("tva CONTROL"); !ok || th != tvaTheme || th.FontMono != "" || th.FontMonoSize != 0 || th.CellHeight != 0 {
		t.Fatal("TVA Control lookup is missing, or it sets the pane font")
	}
	if th, ok := Builtin("tva LIGHT"); !ok || th != tvaLightTheme || th.FontMono != "" || th.FontMonoSize != 0 || th.CellHeight != 0 {
		t.Fatal("TVA Light lookup is missing, or it sets the pane font")
	}
	if len(Builtins) != 5 {
		t.Fatalf("builtins %v", Builtins)
	}
}

func TestGhosttyAdapter(t *testing.T) {
	for _, term := range []*terminal.Theme{
		{Background: ui.Hex("#101418"), Foreground: ui.Hex("#eeeeee")},
		{Background: ui.Hex("#FFFFFF"), Foreground: ui.Hex("#1F2328"), Palette: [16]ui.Color{1: ui.Hex("#CF222E"), 2: ui.Hex("#116329"), 3: ui.Hex("#4D2D00"), 4: ui.Hex("#0969DA")}},
	} {
		g := Ghostty(term)
		dark := luminance(term.Background) < 0.5
		if g.Name != GhosttyName || g.Dark != dark || g.Container.Background != term.Background || g.Terminal.Background != term.Background {
			t.Fatalf("ghostty %+v", g)
		}
		if g.Sidebar != mix(term.Background, term.Foreground, 0.04) || g.Sidebar == Light.Sidebar || g.Sidebar == Dark.Sidebar {
			t.Errorf("sidebar %v", g.Sidebar)
		}
		if term.Palette[4].A != 0 && g.Accent != term.Palette[4] {
			t.Errorf("accent %v, want the palette's blue", g.Accent)
		}
		for name, pair := range map[string][2]ui.Color{
			"sidebar": {g.SidebarForeground, g.Sidebar}, "row": {g.Row.Base.Foreground, g.Sidebar},
			"selected": {g.Row.Active.Foreground, g.Row.Active.Background}, "tab bar": {g.Tab.Base.Foreground, g.TabBar},
		} {
			if d := luminance(pair[0]) - luminance(pair[1]); d*d < 0.09 {
				t.Errorf("%s: text %v on %v is too faint", name, pair[0], pair[1])
			}
		}
		if g.Widget().Focus != g.Accent.Alpha(0.55) {
			t.Errorf("focus %v", g.Widget().Focus)
		}
		if g.Widget() == Light.Widget() || g.Widget() == Dark.Widget() {
			t.Error("the adapter kept the built-in's widget theme")
		}
	}
	if Dark.Terminal.Background == ui.Hex("#101418") {
		t.Fatal("the adapter changed Nord")
	}
}

func TestSettings(t *testing.T) {
	dir := t.TempDir()
	s, err := LoadSettings(dir)
	if err != nil || s != DefaultSettings() {
		t.Fatalf("missing file %v %v", s, err)
	}
	want := Settings{Theme: "Ink", ThemeDark: "Nord", FollowSystem: false}
	if err := SaveSettings(filepath.Join(dir, "sub"), want); err != nil {
		t.Fatal(err)
	}
	if got, err := LoadSettings(filepath.Join(dir, "sub")); err != nil || got != want {
		t.Fatalf("round trip %v %v", got, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte("{oops"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := LoadSettings(dir); err == nil || got != DefaultSettings() {
		t.Fatalf("bad file %v %v, want the defaults and an error", got, err)
	}
	left, _ := filepath.Glob(filepath.Join(dir, "sub", "settings-*"))
	if len(left) != 0 {
		t.Fatalf("temporary files left: %v", left)
	}
}
