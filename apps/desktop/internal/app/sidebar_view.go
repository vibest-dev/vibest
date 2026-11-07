package app

import (
	"time"

	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo/ui"
)

const sidebarSlide = 260 * time.Millisecond

var sidebarMotion = ui.Animation{Duration: sidebarSlide, Ease: ui.CubicBezier(0.25, 1, 0.5, 1)}

func clampSidebar(width, windowW float32) float32 {
	maxW := windowW * chrome.SidebarMaxFrac
	if maxW < chrome.SidebarMin {
		maxW = chrome.SidebarMin
	}
	if width < chrome.SidebarMin {
		return chrome.SidebarMin
	}
	if width > maxW {
		return maxW
	}
	return width
}

func (a *App) sidebar(c *ui.Context, shown, full, winW float32) {
	ui.Row(c).Width(shown).FillHeight().Shrink(0).ClipX().Children(func() {
		ui.Row(c).Width(full).FillHeight().Shrink(0).Margin(0, 0, 0, shown-full).Opacity(0.4 + 0.6*shown/full).Children(func() {
			a.sidebarColumn(c, full-3)
			a.sidebarGrip(c, winW)
		})
	})
}

func (a *App) sidebarColumn(c *ui.Context, w float32) {
	th := a.th
	ui.Column(c).Width(w).FillHeight().Background(th.Sidebar).Padding(0, 0, chrome.Step8, chrome.Step8).Gap(6).DragWindow().Label("sidebar").Children(func() {
		ui.Box(c).Height(topBarHeight(c)).FillWidth().Shrink(0)
		barW := c.Theme().ScrollbarWidth
		if barW <= 0 {
			barW = 6
		}
		bg := th.Sidebar
		ink := th.Widget().Scrollbar
		list := ui.Scroll(c).Grow(1).TrackScroll(&a.sideScroll).Label("workspace-list")
		over := list.Hovered()
		list.DrawOver(func(p *ui.Painter, r ui.Rect) {
			if !over {
				return
			}
			cover, thumb, ok := flushThumb(r, a.sideScroll.Y, a.sideScroll.MaxY, barW)
			if !ok {
				return
			}
			p.Fill(cover, bg, 0)
			p.Fill(thumb, ink, barW/2)
		})
		list.Children(func() {
			ui.Column(c).FillWidth().Padding(0, chrome.Step8, 0, 0).Gap(2).FocusGroup(ui.Vertical).Children(func() {
				a.projectSection(c)
				_, project := a.vibestModel.Projects[a.currentProject()]
				b := a.rowButton(c, "terminals", !project).FillWidth().Label("Terminals")
				b.Children(func() {
					ui.Text(c, "Terminals").Label("terminals-name").FontSize(th.Row.FontSize).TextColor(a.rowInk(th.Row.Pick(!project, b.Hovered(), a.windowFocused)))
				})
				b.Menu(a.terminalsMenu)
			})
		})
		ui.Row(c).FillWidth().Padding(0, chrome.Step8, 0, 0).Justify(ui.End).AlignItems(ui.Center).Children(func() {
			a.iconButton(c, chrome.IconTheme, "Theme").Menu(a.themeMenu)
		})
	})
}

func flushThumb(r ui.Rect, y, maxY, width float32) (cover, thumb ui.Rect, ok bool) {
	if maxY <= 0 || r.H <= 4 || width <= 0 {
		return ui.Rect{}, ui.Rect{}, false
	}
	view := r.H
	content := view + maxY
	inner := view - 4
	th := min(max(inner*view/content, 24), inner)
	travel := inner - th
	at := float32(0)
	if content > view {
		at = max(0, min(travel*y/(content-view), travel))
	}
	top := r.Y + 2 + at
	thumb = ui.Rect{X: r.X + r.W - width, Y: top, W: width, H: th}
	cover = ui.Rect{X: thumb.X - 5, Y: top, W: width + 5, H: th}
	return cover, thumb, true
}

func (a *App) sidebarGrip(c *ui.Context, windowW float32) {
	g := ui.Row(c).Width(3).FillHeight().Shrink(0).Cursor(ui.CursorResizeEW).AlignItems(ui.Stretch).Label("sidebar-grip")
	g.Children(func() {
		if a.comfortable() {
			ui.Box(c).Width(3).FillHeight().Background(a.th.Sidebar)
			return
		}
		line := a.th.SidebarBorder
		if line.A == 0 {
			line = a.th.Sidebar
		}
		ui.Box(c).Width(2).FillHeight().Background(a.th.Sidebar)
		ui.Box(c).Width(1).FillHeight().Background(line)
	})
	a.dragSidebar(g, windowW)
}

func (a *App) sidebarGripEdge(c *ui.Context, windowW float32) {
	e := ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).Width(2).Cursor(ui.CursorResizeEW).Label("sidebar-grip-edge")
	a.dragSidebar(e, windowW)
}

func (a *App) dragSidebar(e ui.Element, windowW float32) {
	if dx, _, held := e.Dragged(); held {
		a.sideWidth = clampSidebar(a.sideWidth+dx, windowW)
	}
	if _, _, ended := e.DragEnded(); ended {
		a.themes.settings.SidebarWidth = a.sideWidth
		a.saveSettings()
	}
}

func (a *App) rowButton(c *ui.Context, key string, on bool) ui.Element {
	th := a.th
	b := ui.ButtonBase(c.Key(key)).Justify(ui.Start).AlignItems(ui.Center).Padding(5, chrome.Step8).Radius(th.Radius).Gap(6)
	th.Row.Pick(on, b.Hovered(), a.windowFocused).Apply(b)
	return b
}

func (a *App) rowInk(st chrome.Style) ui.Color {
	if st.Foreground.A == 0 {
		return a.th.SidebarForeground
	}
	return st.Foreground
}

func toggleX(c *ui.Context) float32 { return c.TitleBar().Left + chrome.Step8 }

func (a *App) sidebarControls(c *ui.Context) {
	tip, glyph := "Hide sidebar", chrome.IconSidebar
	if !a.sidebarVisible {
		tip, glyph = "Show sidebar", chrome.IconSidebarShow
	}
	th := a.th
	y := (topBarHeight(c) - th.IconButton) / 2
	b := a.iconButton(c.Key("toggle-sidebar"), glyph, tip).Absolute().Left(toggleX(c)).Top(y)
	if b.Clicked() {
		a.toggleSidebar()
	}
	b = a.iconButton(c.Key("new-workspace"), chrome.IconPlus, "new-workspace").Tooltip("New workspace (⌘N)").Absolute().Left(toggleX(c) + th.IconButton + chrome.Step4).Top(y)
	if b.Clicked() {
		a.NewWorkspace()
		a.returnFocus = true
		c.Invalidate()
	}
}
