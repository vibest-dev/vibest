package chrome

import (
	"math"
	"strings"

	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

var Builtins = []string{"Paper", "Newsprint", "TVA Light", "Nord", "TVA Control"}

var (
	paperTheme     = paper()
	newsprintTheme = newsprint()
	nordTheme      = nord()
	tvaTheme       = tva()
	tvaLightTheme  = tvaLight()
)

func Builtin(name string) (*Theme, bool) {
	switch strings.ToLower(name) {
	case "paper":
		return paperTheme, true
	case "newsprint":
		return newsprintTheme, true
	case "nord":
		return nordTheme, true
	case "tva control":
		return tvaTheme, true
	case "tva light":
		return tvaLightTheme, true
	}
	return nil, false
}

func paper() *Theme {
	card := style("#FFFFFF", "#1A1A1A", 400)
	card.Border, card.BorderWidth = ui.Hex("#E0DFD5"), 1
	card.Shadows = []Shadow{{Y: 1, Blur: 2, Color: ui.Color{A: 5}}}
	tab := card
	tab.Shadows = []Shadow{{Y: 1, Blur: 4, Color: ui.Color{A: 15}}}
	return finish(&Theme{
		Name:       "Paper",
		Foreground: ui.Hex("#1A1A1A"), Secondary: ui.Hex("#8C8A80"), Tertiary: ui.Hex("#C1BEB5"),
		Accent: ui.Hex("#2B5A38"), AccentForeground: ui.Hex("#FFFFFF"),
		Success: ui.Hex("#2B5A38"), Warning: ui.Hex("#A85A20"), Danger: ui.Hex("#A33A3A"),
		FontUI:     "system-ui",
		Shadows:    []Shadow{{Y: 1, Blur: 2, Color: ui.Color{A: 5}}},
		Background: ui.Hex("#F5F4F0"), Surface: ui.Hex("#FCFBF9"), Border: ui.Hex("#E0DFD5"),
		Sidebar: ui.Hex("#F5F4F0"), SidebarForeground: ui.Hex("#1A1A1A"), SidebarBorder: ui.Hex("#E0DFD5"),
		Row: States{
			Base: style("", "#8C8A80", 400), Hover: style("#EBEAE5", "", 400),
			Active: card, ActiveUnfocused: nostamp(card), FontSize: 13,
		},
		Tab: States{
			Base: style("", "#8C8A80", 400), Hover: style("#EBEAE5", "", 400),
			Active: tab, ActiveUnfocused: nostamp(tab), FontSize: 13,
		},
		TabBar:    ui.Hex("#F5F4F0"),
		Container: Style{Background: ui.Hex("#FCFBF9")},
		Divider:   ui.Hex("#E0DFD5"),
		Terminal: &terminal.Theme{
			Foreground: ui.Hex("#1A1A1A"), Background: ui.Hex("#FCFBF9"),
			Cursor: ui.Hex("#1A1A1A"), CursorText: ui.Hex("#FCFBF9"),
			Selection: ui.Hex("#E0DFD5"),
			Palette: palette(
				"#1A1A1A", "#A33A3A", "#2B5A38", "#A85A20",
				"#4A7A8A", "#4A3A6A", "#3A7A6A", "#474646",
				"#8C8A80", "#C36A6A", "#6B9A78", "#C88A50",
				"#7A9AAA", "#8A7A9A", "#6ABAAA", "#2F2E2E",
			),
		},
	})
}

func newsprint() *Theme {
	card := style("#6D7478", "#FFFFFF", 500)
	tab := card
	tab.Shadows = []Shadow{{Y: 1, Blur: 4, Color: ui.Color{A: 13}}}
	return finish(&Theme{
		Name:       "Newsprint",
		Foreground: ui.Hex("#262522"), Secondary: ui.Hex("#7A766B"), Tertiary: ui.Hex("#B8B3A6"),
		Accent: ui.Hex("#2F5F8A"), AccentForeground: ui.Hex("#FFFFFF"),
		Success: ui.Hex("#5C7A3E"), Warning: ui.Hex("#967927"), Danger: ui.Hex("#A33A35"),
		FontUI:     "system-ui",
		Shadows:    []Shadow{{Y: 1, Blur: 2, Color: ui.Color{A: 8}}},
		Background: ui.Hex("#F3F2EE"), Surface: ui.Hex("#F4F1EA"), Border: ui.Hex("#DBD6C8"),
		Sidebar: ui.Hex("#F4F4F1"), SidebarForeground: ui.Hex("#262522"), SidebarBorder: ui.Hex("#DBD6C8"),
		Row: States{
			Base:   style("", "#7A766B", 400),
			Hover:  style("#DFDDD5", "", 400),
			Active: card, ActiveUnfocused: card, FontSize: 13,
		},
		Tab: States{
			Base:   style("", "#7A766B", 400),
			Hover:  style("#DFDCD3", "", 400),
			Active: tab, ActiveUnfocused: nostamp(tab), FontSize: 13,
		},
		TabBar:    ui.Hex("#F3F2EE"),
		Container: Style{Background: ui.Hex("#F4F4F1")},
		Divider:   ui.Hex("#DBD6C8"),
		FontMono:  "Office Code Pro",
		Terminal: &terminal.Theme{
			Foreground: ui.Hex("#333638"), Background: ui.Hex("#F4F4F1"),
			Cursor: ui.Hex("#333638"), CursorText: ui.Hex("#F4F4F1"),
			Selection: ui.Hex("#DBD6C8"),
			Palette: palette(
				"#262522", "#A33A35", "#5C7A3E", "#967927",
				"#2F5F8A", "#904180", "#3E7A78", "#434340",
				"#7A766B", "#C25852", "#7A9A52", "#D4A945",
				"#4470A0", "#BE79BB", "#739797", "#121211",
			),
		},
	})
}

func nord() *Theme {
	card := style("#3B4252", "#ECEFF4", 500)
	card.Shadows = []Shadow{{Y: 1, Blur: 2, Color: ui.Color{A: 64}}}
	return finish(&Theme{
		Name: "Nord", Dark: true,
		Foreground: ui.Hex("#E5E9F0"), Secondary: ui.Hex("#C0C7D3"), Tertiary: ui.Hex("#7B8294"),
		Accent: ui.Hex("#88C0D0"), AccentForeground: ui.Hex("#1A1A1A"),
		Success: ui.Hex("#A3BE8C"), Warning: ui.Hex("#EBCB8B"), Danger: ui.Hex("#BF616A"),
		FontUI:     "system-ui",
		Shadows:    []Shadow{{Y: 8, Blur: 24, Color: ui.Color{A: 89}}},
		Background: ui.Hex("#2E3440"), Surface: ui.Hex("#3B4252"),
		Border:            ui.Hex("#3A404B"),
		Sidebar:           ui.Hex("#2E3440"),
		SidebarForeground: ui.Hex("#E5E9F0"),
		SidebarBorder:     ui.Hex("#434C5E"),
		Row: States{
			Base:   style("", "#C0C7D3", 400),
			Hover:  style("#393E4A", "", 400),
			Active: card, ActiveUnfocused: style("#3B4252", "#C0C7D3", 500),
			FontSize: 13,
		},
		Tab: States{
			Base:   style("", "#C0C7D3", 400),
			Hover:  style("#393E4A", "", 400),
			Active: card, ActiveUnfocused: style("#3B4252", "#C0C7D3", 500),
			FontSize: 13,
		},
		TabBar:    ui.Hex("#2E3440"),
		Container: Style{Background: ui.Hex("#2E3440")},
		Divider:   ui.Hex("#3E444F"),
		Terminal: &terminal.Theme{
			Foreground: ui.Hex("#F1F6FF"), Background: ui.Hex("#2E3440"),
			Cursor: ui.Hex("#E5E9F0"), CursorText: ui.Hex("#2E3440"),
			Selection: ui.Hex("#E5E9F0"), SelectionText: ui.Hex("#2E3440"),
			Palette: palette(
				"#3B4252", "#BF616A", "#A3BE8C", "#EBCB8B",
				"#81A1C1", "#B48EAD", "#88C0D0", "#E5E9F0",
				"#4C566A", "#BF616A", "#A3BE8C", "#EBCB8B",
				"#81A1C1", "#B48EAD", "#8FBCBB", "#ECEFF4",
			),
		},
	})
}

func tva() *Theme {
	card := style("#493627", "#EAD9B9", 500)
	card.Border, card.BorderWidth = ui.Hex("#F0A04B"), 1
	away := style("#382F27", "#C0AA8B", 500)
	away.Border, away.BorderWidth = ui.Hex("#A18D72"), 1
	return finish(&Theme{
		Name: "TVA Control", Dark: true,
		Foreground: ui.Hex("#EAD9B9"), Secondary: ui.Hex("#C0AA8B"), Tertiary: ui.Hex("#A18D72"),
		Accent: ui.Hex("#F0A04B"), AccentForeground: ui.Hex("#211D19"),
		Success: ui.Hex("#B2BB78"), Warning: ui.Hex("#E3B66B"), Danger: ui.Hex("#E88C76"),
		FontUI:     "system-ui",
		Shadows:    []Shadow{{Y: 8, Blur: 24, Color: ui.Color{A: 89}}},
		Background: ui.Hex("#211D19"), Surface: ui.Hex("#302922"), Border: ui.Hex("#64533F"),
		Sidebar: ui.Hex("#211D19"), SidebarForeground: ui.Hex("#EAD9B9"), SidebarBorder: ui.Hex("#64533F"),
		Row: States{
			Base: style("", "#C0AA8B", 400), Hover: style("#302922", "#EAD9B9", 400),
			Active: card, ActiveUnfocused: away, FontSize: 13,
		},
		Tab: States{
			Base: style("", "#C0AA8B", 400), Hover: style("#302922", "#EAD9B9", 400),
			Active: card, ActiveUnfocused: away, FontSize: 13,
		},
		TabBar:    ui.Hex("#211D19"),
		Container: Style{Background: ui.Hex("#211D19")},
		Divider:   ui.Hex("#64533F"),
		Terminal: &terminal.Theme{
			Foreground: ui.Hex("#EAD9B9"), Background: ui.Hex("#211D19"),
			Cursor: ui.Hex("#F0A04B"), CursorText: ui.Hex("#211D19"),
			Selection: ui.Hex("#E3B66B"), SelectionText: ui.Hex("#211D19"),
			Palette: palette(
				"#9F8A72", "#E88C76", "#B2BB78", "#E3B66B",
				"#8EADBC", "#C79DAD", "#91B6A4", "#DFCEB1",
				"#B6A18A", "#FFA08A", "#CAD390", "#FFD089",
				"#AACBD8", "#DFB8C9", "#ADD6C2", "#FFF0D3",
			),
		},
	})
}

func tvaLight() *Theme {
	card := style("#E6E4DF", "#33251A", 500)
	card.Border, card.BorderWidth = ui.Hex("#873511"), 1
	away := style("#ECEAE5", "#4E4236", 500)
	away.Border, away.BorderWidth = ui.Hex("#817C73"), 1
	t := finish(&Theme{
		Name:       "TVA Light",
		Foreground: ui.Hex("#33251A"), Secondary: ui.Hex("#4E4236"), Tertiary: ui.Hex("#5E5142"),
		Accent: ui.Hex("#873511"), AccentForeground: ui.Hex("#FAF9F6"),
		Success: ui.Hex("#45540F"), Warning: ui.Hex("#6E4C08"), Danger: ui.Hex("#8E2236"),
		FontUI:     "system-ui",
		Shadows:    []Shadow{{Y: 4, Blur: 12, Color: ui.Color{A: 31}}},
		Background: ui.Hex("#F3F2EF"), Surface: ui.Hex("#FAF9F6"), Border: ui.Hex("#CCC8C0"),
		Sidebar: ui.Hex("#F3F2EF"), SidebarForeground: ui.Hex("#33251A"), SidebarBorder: ui.Hex("#CCC8C0"),
		Row: States{
			Base: style("", "#4E4236", 400), Hover: style("#EAE8E3", "#33251A", 400),
			Active: card, ActiveUnfocused: away, FontSize: 13,
		},
		Tab: States{
			Base: style("", "#4E4236", 400), Hover: style("#EAE8E3", "#33251A", 400),
			Active: card, ActiveUnfocused: away, FontSize: 13,
		},
		TabBar:    ui.Hex("#F3F2EF"),
		Container: Style{Background: ui.Hex("#FAF9F6")},
		Divider:   ui.Hex("#CCC8C0"),
		Terminal: &terminal.Theme{
			Foreground: ui.Hex("#33251A"), Background: ui.Hex("#FAF9F6"),
			Cursor: ui.Hex("#873511"), CursorText: ui.Hex("#FAF9F6"),
			Selection: ui.Hex("#DDD9D0"), SelectionText: ui.Hex("#2A1D13"),
			Palette: palette(
				"#2A1F17", "#7B1F1F", "#344511", "#563B06",
				"#1E4169", "#6A255C", "#154847", "#493F35",
				"#5B4F44", "#982621", "#43570E", "#6F4B00",
				"#25528E", "#822F7C", "#105B57", "#2B221B",
			),
		},
	})
	t.widget.Focus = t.Accent
	return t
}

func finish(t *Theme) *Theme {
	t.Working, t.Blocked, t.Done = t.Warning, t.Danger, t.Success
	t.FontSize, t.FontSizeSmall = 13, 11
	t.Radius = 4
	t.Slot, t.Mark = Step12, 10
	t.GroupIndent, t.TabWidth = Step12, 140
	t.IconButton, t.Icon = Step24, IconSize
	t.makeWidget()
	return t
}

func style(bg, fg string, weight int) Style {
	s := Style{Weight: weight}
	if bg != "" {
		s.Background = ui.Hex(bg)
	}
	if fg != "" {
		s.Foreground = ui.Hex(fg)
	}
	return s
}

func nostamp(s Style) Style {
	s.Shadows = nil
	return s
}

func palette(hexes ...string) [16]ui.Color {
	var p [16]ui.Color
	for i, h := range hexes {
		if i < len(p) {
			p[i] = ui.Hex(h)
		}
	}
	return p
}

const GhosttyName = "Ghostty"

func Ghostty(term *terminal.Theme) *Theme {
	base := Light
	if luminance(term.Background) < 0.5 {
		base = Dark
	}
	t := *base
	th := *term
	bg := flatten(th.Background, base.Background)
	th.Background = bg
	fg := th.Foreground
	if fg.A == 0 {
		fg = base.Foreground
	}
	shade := func(k float32) ui.Color { return mix(bg, fg, k) }
	t.Name, t.Terminal = GhosttyName, &th
	t.Background, t.Sidebar, t.TabBar = shade(0.04), shade(0.04), shade(0.04)
	t.Surface = bg
	t.Border = shade(0.14)
	t.SidebarBorder, t.Divider = t.Border, t.Border
	t.Foreground, t.SidebarForeground = fg, fg
	t.Secondary, t.Tertiary = shade(0.6), shade(0.4)
	ansi := func(i int, def ui.Color) ui.Color {
		if th.Palette[i].A == 0 {
			return def
		}
		return th.Palette[i]
	}
	t.Accent, t.Success = ansi(4, base.Accent), ansi(2, base.Success)
	t.Warning, t.Danger = ansi(3, base.Warning), ansi(1, base.Danger)
	t.AccentForeground = ui.Hex("#FFFFFF")
	if luminance(t.Accent) > 0.55 {
		t.AccentForeground = ui.Hex("#1A1A1A")
	}
	t.Working, t.Blocked, t.Done = t.Warning, t.Danger, t.Success
	card := bg
	if t.Dark {
		card = shade(0.1)
	}
	states := func(s States) States {
		s.Base.Foreground = t.Secondary
		s.Hover.Background, s.Hover.Foreground = shade(0.08), fg
		for _, st := range []*Style{&s.Active, &s.ActiveUnfocused} {
			st.Background, st.Foreground = card, fg
			if st.BorderWidth > 0 {
				st.Border = t.Border
			}
		}
		s.ActiveUnfocused.Foreground = t.Secondary
		return s
	}
	t.Row, t.Tab = states(base.Row), states(base.Tab)
	t.Container.Background = bg
	t.makeWidget()
	return &t
}

func flatten(c, under ui.Color) ui.Color {
	if c.A == 255 {
		return c
	}
	a := float32(c.A) / 255
	return ui.Color{R: blend(under.R, c.R, a), G: blend(under.G, c.G, a), B: blend(under.B, c.B, a), A: 255}
}

func mix(a, b ui.Color, k float32) ui.Color {
	return ui.Color{R: blend(a.R, b.R, k), G: blend(a.G, b.G, k), B: blend(a.B, b.B, k), A: a.A}
}

func blend(a, b uint8, k float32) uint8 {
	return uint8(math.Round(float64(float32(a)*(1-k) + float32(b)*k)))
}

func luminance(c ui.Color) float64 {
	return (0.2126*float64(c.R) + 0.7152*float64(c.G) + 0.0722*float64(c.B)) / 255
}
