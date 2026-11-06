package chrome

import (
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

const (
	Step4  float32 = 4
	Step8  float32 = 8
	Step12 float32 = 12
	Step16 float32 = 16
	Step20 float32 = 20
	Step24 float32 = 24
)

const IconSize float32 = 14

const (
	SidebarWidth   float32 = 248
	SidebarMin     float32 = 160
	SidebarMaxFrac float32 = 0.3
)

type Shadow struct {
	X, Y, Blur, Spread float32
	Color              ui.Color
}

type Style struct {
	Background, Foreground ui.Color
	Border                 ui.Color
	BorderWidth            float32
	Shadows                []Shadow
	Weight                 int
}

type States struct {
	Base, Hover, Active, ActiveUnfocused Style
	FontSize                             float32
}

func (s *States) Pick(active, hover, windowFocused bool) Style {
	switch {
	case active && !windowFocused:
		return s.ActiveUnfocused
	case active:
		return s.Active
	case hover:
		return s.Hover
	}
	return s.Base
}

func (st Style) Apply(e ui.Element) ui.Element {
	if st.Background.A > 0 {
		e.Background(st.Background)
	}
	if st.BorderWidth > 0 && st.Border.A > 0 {
		e.InsetShadow(0, 0, 0, st.BorderWidth, st.Border)
	}
	for _, s := range st.Shadows {
		e.Shadow(s.X, s.Y, s.Blur, s.Spread, s.Color)
	}
	return e
}

type Theme struct {
	Name string
	Dark bool

	Foreground, Secondary, Tertiary ui.Color
	Accent, AccentForeground        ui.Color
	Success, Warning, Danger        ui.Color
	Radius                          float32
	Shadows                         []Shadow
	FontUI                          string
	FontSize, FontSizeSmall         float32

	Background, Surface, Border ui.Color

	Sidebar, SidebarForeground, SidebarBorder ui.Color

	Row, Tab States
	TabBar   ui.Color

	Container Style

	Divider ui.Color

	Terminal     *terminal.Theme
	FontMono     string
	FontMonoSize float32
	CellHeight   float32

	Working, Blocked, Done ui.Color

	Slot             float32
	Mark             float32
	GroupIndent      float32
	TabWidth         float32
	IconButton, Icon float32

	widget *ui.Theme
}

func (t *Theme) Widget() *ui.Theme { return t.widget }

func (t *Theme) makeWidget() {
	th := ui.LightTheme()
	if t.Dark {
		th = ui.DarkTheme()
	}
	th.Dark = t.Dark
	th.Background = t.Background
	th.Surface = t.Surface
	th.SurfaceHover = t.Row.Hover.Background
	th.SurfacePressed = t.Row.Active.Background
	th.Border = t.Border
	th.Text = t.Foreground
	th.TextMuted = t.Secondary
	th.Accent = t.Accent
	th.AccentHover = mix(t.Accent, t.Foreground, 0.12)
	th.AccentPressed = mix(t.Accent, t.Foreground, 0.24)
	th.AccentText = t.AccentForeground
	th.Danger = t.Danger
	th.Focus = t.Accent.Alpha(0.55)
	th.Selection = t.Accent.Alpha(0.22)
	th.Scrollbar = t.Tertiary.Alpha(0.6)
	th.Radius = t.Radius
	th.Spacing = 3
	th.Font = t.FontUI
	th.FontSize = t.FontSize
	t.widget = th
}

var (
	Light = paperTheme
	Dark  = nordTheme
)
