package app

import (
	"fmt"
	"time"
	"vibest-desktop/internal/presentation"

	"vibest-desktop/internal/chrome"

	"vibest-desktop/internal/sidebar"

	"github.com/egoist/mygo/ui"
)

const sidebarSlide = 260 * time.Millisecond

var sidebarMotion = ui.Animation{Duration: sidebarSlide, Ease: ui.CubicBezier(0.25, 1, 0.5, 1)}

func paintMark(c *ui.Context, th *chrome.Theme, glyph string, color ui.Color) {
	box := ui.Row(c).Size(th.Slot, th.Slot).Shrink(0)
	box.Draw(func(p *ui.Painter, r ui.Rect) {
		drawMark(p, r, glyph, color, th.Mark)
	})
	box.Children(func() {
		ui.Text(c, glyph).FontSize(chrome.Step12).TextColor(ui.RGBA(color.R, color.G, color.B, 0)).SingleLine()
	})
}

func drawMark(p *ui.Painter, r ui.Rect, glyph string, color ui.Color, size float32) {
	cx := r.X + r.W/2
	cy := r.Y + r.H/2
	half := size / 2
	switch glyph {
	case "▾":
		path := &ui.Path{}
		path.MoveTo(cx-half, cy-half*0.45).LineTo(cx+half, cy-half*0.45).LineTo(cx, cy+half*0.7).Close()
		p.FillPath(path, color)
	case "▸":
		path := &ui.Path{}
		path.MoveTo(cx-half*0.5, cy-half).LineTo(cx+half*0.65, cy).LineTo(cx-half*0.5, cy+half).Close()
		p.FillPath(path, color)
	default:
		return
	}
}

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
				owned := map[string]bool{}
				for _, w := range a.coreState.Layout.Workspaces {
					if w.Project != "" {
						owned[w.ID] = true
					}
				}
				for _, m := range a.machines {
					a.machineItem(c, m)
					if m.snap == nil || a.foldedMachines[m.sidebarID()] {
						continue
					}
					for _, e := range sidebar.VisibleEntries(m.snap.Workspaces, a.collapsed[m.id()]) {
						if owned[m.snap.Workspaces[e.Index].ID] {
							continue
						}
						if m == a.machine {
							a.workspaceItem(c, m.snap.Workspaces[e.Index], e)
						} else {
							a.otherWorkspaceItem(c, m, m.snap.Workspaces[e.Index], e)
						}
					}
				}
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
	b := ui.ButtonBase(c).Key(key).Justify(ui.Start).AlignItems(ui.Center).Padding(5, chrome.Step8).Radius(th.Radius).Gap(6)
	th.Row.Pick(on, b.Hovered(), a.windowFocused).Apply(b)
	return b
}

func (a *App) rowInk(st chrome.Style) ui.Color {
	if st.Foreground.A == 0 {
		return a.th.SidebarForeground
	}
	return st.Foreground
}

func (a *App) workspaceItem(c *ui.Context, ws presentation.Workspace, e sidebar.Entry) {
	name := label(ws.Label, ws.Number)
	on := ws.ID == a.snap.FocusedWorkspaceID
	row := ui.Row(c).Gap(2).AlignItems(ui.Center)
	if e.Child {
		row.Padding(0, 0, 0, a.th.GroupIndent)
	}
	row.Children(func() {
		a.workspaceButton(c, ws, e, name, on)
	})
}

func (a *App) toggleFold(m *machine, key string) {
	if a.collapsed[m.id()] == nil {
		a.collapsed[m.id()] = map[string]bool{}
	}
	a.collapsed[m.id()][key] = !a.collapsed[m.id()][key]
}

func (a *App) foldControl(c *ui.Context, m *machine, key string, ink ui.Color) {
	label, mark := a.foldWord(m, key)
	th := a.th
	b := ui.ButtonBase(c.Key("repository-disclosure")).Size(th.Slot, th.Slot).Padding(0).Radius(0).Shrink(0).KeepFocus().Role(ui.RoleDisclosure).Expanded(!a.collapsed[m.id()][key]).Label(label)
	b.Children(func() { paintMark(c, th, mark, ink) })
	if b.Clicked() {
		a.toggleFold(m, key)
	}
}

func (a *App) workspaceButton(c *ui.Context, ws presentation.Workspace, e sidebar.Entry, name string, on bool) {
	th := a.th
	status, description := a.activity(activityScope{workspace: ws.ID})
	b := a.rowButton(c, ws.ID, on).Grow(1).Description(description)
	st := th.Row.Pick(on, b.Hovered(), a.windowFocused)
	ink := a.rowInk(st)
	b.Children(func() {
		if e.GroupParent() {
			a.foldControl(c, a.machine, e.Group, ink)
		} else {
			ui.Box(c).Size(th.Slot, th.Slot).Shrink(0).PassThrough()
		}
		a.workspaceText(c, ws, name, st.Weight, ink)
		paintActivity(c, th, status)
	})
	if b.Clicked() {
		a.SelectWorkspace(ws.ID)
		a.returnFocus = true
	}
	linked := ws.Worktree != nil && ws.Worktree.Linked
	b.ContextMenu(func(m *ui.Menu) { a.sideMenu(m, a.machine, ws.ID, name, e, linked) })
}

func (a *App) workspaceText(c *ui.Context, ws presentation.Workspace, name string, weight int, ink ui.Color) {
	th := a.th
	ui.Column(c).Grow(1).MinWidth(0).Children(func() {
		ui.Text(c, name).FontSize(th.Row.FontSize).FontWeight(weight).TextColor(ink).SingleLine()
		if ws.Branch != "" {
			branch := ws.Branch
			if len(ws.AheadBehind) == 2 && (ws.AheadBehind[0] > 0 || ws.AheadBehind[1] > 0) {
				branch += fmt.Sprintf(" ↑%d↓%d", ws.AheadBehind[0], ws.AheadBehind[1])
			}
			ui.Text(c, branch).FontSize(th.FontSizeSmall).TextColor(th.Secondary).SingleLine()
		}
	})
}

func (a *App) sideMenu(m *ui.Menu, owner *machine, id, name string, e sidebar.Entry, linked bool) {
	if m.Item("Refresh Git metadata").Chosen() {
		a.RefreshRepository(id)
	}
	if m.Item("Rename").Chosen() {
		a.ask("Rename", name, false, func(v string) { a.RenameWorkspace(id, v) })
	}
	if e.GroupParent() {
		key := e.Group
		fold, _ := a.foldWord(owner, key)
		if m.Item("Close group").Chosen() {
			a.CloseWorkspaceGroup(id)
		}
		if m.Item("New worktree").Chosen() {
			a.ask("New worktree", "", false, func(v string) {
				if v != "" {
					a.CreateWorktree(id, v)
				}
			})
		}
		if m.Item("Open worktree...").Chosen() {
			a.ask("Open worktree", "", false, func(v string) {
				if v != "" {
					a.OpenWorktree(id, v)
				}
			})
		}
		if m.Item(fold).Chosen() {
			a.toggleFold(owner, key)
		}
		return
	}
	if m.Item("Close").Chosen() {
		a.CloseWorkspace(id)
	}
	if linked && m.Item("Delete worktree checkout...").Chosen() {
		a.RemoveWorktree(id)
	}
}

func (a *App) foldWord(m *machine, key string) (label, mark string) {
	if a.collapsed[m.id()][key] {
		return "Expand", "▸"
	}
	return "Collapse", "▾"
}

func (a *App) machineItem(c *ui.Context, m *machine) {
	th := a.th
	id := m.sidebarID()
	ui.Row(c).Key("machine-header/" + id).FillWidth().Gap(2).AlignItems(ui.Center).Children(func() {
		folded := a.foldedMachines[id]
		action, glyph := "Collapse machine: ", "▾"
		if folded {
			action, glyph = "Expand machine: ", "▸"
		}
		disclosure := ui.ButtonBase(c).Key("machine-disclosure/"+id).Size(th.IconButton, th.IconButton).Padding(0).Radius(th.Radius).KeepFocus().Role(ui.RoleDisclosure).Expanded(!folded).Label(action + m.label()).Tooltip(action + m.label())
		if disclosure.Hovered() {
			disclosure.Background(th.Row.Hover.Background)
		}
		disclosure.Children(func() { paintMark(c, th, glyph, th.Secondary) })
		if disclosure.Clicked() {
			a.foldedMachines[id] = !folded
		}
		b := a.rowButton(c, "machine/"+id, false).Grow(1).MinWidth(0).Label("machine: " + m.label())
		ink := a.rowInk(th.Row.Pick(false, b.Hovered(), a.windowFocused))
		status := ""
		switch {
		case m.connected:
		case m.err == "":
			status = "connecting"
		default:
			status = "offline"
			b.Tooltip(m.err)
		}
		b.Children(func() {
			ui.Text(c, m.label()).FontSize(th.Row.FontSize).FontWeight(600).TextColor(ink).Grow(1).MinWidth(0).SingleLine()
			if status != "" {
				ui.Text(c, status).FontSize(th.FontSizeSmall).TextColor(th.Secondary).Shrink(0).SingleLine()
			}
		})
		if b.Clicked() {
			a.coreActivateMachine(m)
			a.returnFocus = true
		}
	})
}

func (a *App) otherWorkspaceItem(c *ui.Context, m *machine, ws presentation.Workspace, e sidebar.Entry) {
	th := a.th
	row := ui.Row(c).FillWidth()
	if e.Child {
		row.Padding(0, 0, 0, th.GroupIndent)
	}
	row.Children(func() {
		status, description := m.activity(activityScope{workspace: ws.ID})
		b := a.rowButton(c, m.id()+"/"+ws.ID, false).Grow(1).Description(description)
		st := th.Row.Pick(false, b.Hovered(), a.windowFocused)
		ink := a.rowInk(st)
		if !m.connected {
			ink = th.Tertiary
		}
		b.Children(func() {
			if e.GroupParent() {
				a.foldControl(c, m, e.Group, ink)
			} else {
				ui.Box(c).Size(th.Slot, th.Slot).Shrink(0).PassThrough()
			}
			a.workspaceText(c, ws, label(ws.Label, ws.Number), st.Weight, ink)
			paintActivity(c, th, status)
		})
		b.ContextMenu(func(menu *ui.Menu) {
			a.sideMenu(menu, m, ws.ID, label(ws.Label, ws.Number), e, ws.Worktree != nil && ws.Worktree.Linked)
		})
		if b.Clicked() {
			a.showWorkspaceOf(m, ws.ID)
			a.returnFocus = true
		}
	})
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
