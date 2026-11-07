package chrome

import (
	"sync"

	"github.com/egoist/mygo/ui"
)

const (
	GlassShell = 0.81
	GlassPane  = 0.28

	inkHover    = 0.07
	inkSelected = 0.10
	inkBorder   = 0.08
	inkDivider  = 0.10
	inkStrong   = 0.55
)

var glassThemes sync.Map

func (t *Theme) Glass() *Theme {
	if g, ok := glassThemes.Load(t); ok {
		return g.(*Theme)
	}
	g, _ := glassThemes.LoadOrStore(t, glassOf(t))
	return g.(*Theme)
}

func glassOf(t *Theme) *Theme {
	g := *t
	ink := t.Foreground.Alpha
	g.Background = t.Background.Alpha(GlassShell)
	g.Sidebar = t.Sidebar.Alpha(GlassShell)
	g.TabBar = t.TabBar.Alpha(GlassShell)
	g.Container.Background = t.Background.Alpha(GlassPane)
	g.Border, g.SidebarBorder, g.Divider = ink(inkBorder), ink(inkBorder), ink(inkDivider)
	g.Row, g.Tab = glassStates(t.Row, t.Foreground), glassStates(t.Tab, t.Foreground)
	g.makeWidget()
	glassThemes.Store(&g, &g)
	return &g
}

func glassStates(s States, ink ui.Color) States {
	fill := func(st Style, alpha float32, text ui.Color) Style {
		st.Background = ink.Alpha(alpha)
		st.Shadows = nil
		if st.BorderWidth > 0 {
			st.Border = ink.Alpha(inkBorder)
		}
		if text.A > 0 {
			st.Foreground = text
		}
		return st
	}
	s.Base.Foreground = ink.Alpha(inkStrong)
	s.Hover = fill(s.Hover, inkHover, ui.Color{})
	s.Active = fill(s.Active, inkSelected, ink)
	s.ActiveUnfocused = fill(s.ActiveUnfocused, inkHover, ink)
	return s
}
