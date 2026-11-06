package app

import (
	"fmt"
	"runtime"
	"vibest-desktop/internal/presentation"

	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

const (
	tabBarHeight float32 = 36

	windowChromeMin float32 = 42

	outerPad   float32 = chrome.Step8
	sideGutter float32 = chrome.Step4
	interPane  float32 = chrome.Step4

	paneCompact     = "compact"
	paneComfortable = "comfortable"

	macTrafficLightYCompact = 11

	macTrafficLightX int = 18

	macTrafficLightY int = 14
)

func (a *App) TrafficLights() *mygo.Point {
	y := macTrafficLightY
	if !a.comfortable() {
		y = macTrafficLightYCompact
	}
	return &mygo.Point{X: macTrafficLightX, Y: y}
}

type shellMetrics struct {
	outer, gutter, between, radius, bottom float32
}

func metricsFor(v float32) shellMetrics {
	at := func(compact, comfortable float32) float32 { return compact*(1-v) + comfortable*v }
	return shellMetrics{
		outer: at(0, outerPad), gutter: at(0, sideGutter), between: at(0, interPane), radius: at(0, windowCorner/2), bottom: at(2, termBottom),
	}
}

func (a *App) style() float32 {
	if a.styled {
		return a.styleAt
	}
	if a.paneStyle() == paneComfortable {
		return 1
	}
	return 0
}

func (a *App) shell() shellMetrics {
	m := metricsFor(a.style())
	m.outer = onPixel(m.outer, a.g.scale)
	return m
}

func (a *App) comfortable() bool { return a.style() > 0 }

var paneStyleMotion = sidebarMotion

func (a *App) moveStyle(root ui.Element) {
	if d := a.activeTabDrag; d != nil {
		a.styleAt, a.styled = d.style, true
		return
	}
	to := float32(0)
	if a.paneStyle() == paneComfortable {
		to = 1
	}
	a.styleAt, a.styled = root.AnimateTo("pane-style", to, paneStyleMotion), true
	a.styleMoving = !root.Settled("pane-style")
}

func (a *App) headerBand(c *ui.Context) (band, paneTop float32) {
	v, scale := a.style(), a.g.scale
	full := windowChromeHeight(c, scale)
	line := float32(0)
	if a.th.Divider.A > 0 {
		line = gridLine(scale)
	}
	band = onPixel(topBarHeight(c)*(1-v)+full*v, scale)
	return band, onPixel(line*(1-v)+headerGap(full, a.th.IconButton, scale)*v, scale)
}

func (a *App) paneStyle() string {
	if a.themes.settings.PaneStyle == paneCompact {
		return paneCompact
	}
	return paneComfortable
}

func (a *App) setPaneStyle(style string) {
	if style != paneComfortable {
		style = paneCompact
	}
	if a.paneStyle() == style {
		return
	}
	a.themes.settings.PaneStyle = style
	a.saveSettings()
	a.syncNative()
	a.invalidate()
}

var closeX = ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><path d="M1.5 1.5 8.5 8.5"/><path d="M8.5 1.5 1.5 8.5"/></svg>`))

func (a *App) View(c *ui.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	defer a.endSeenFrame()
	a.checkTabDrag()
	a.coreFocus()
	th := a.theme(c.Theme().Dark)
	if a.themes.settings.Translucent && c.Vibrancy() {
		th = th.Glass()
	}
	if th != a.th {
		a.th = th
		a.syncNative()
	}
	c.SetTheme(th.Widget())
	for _, u := range a.open {
		c.Services().OpenURL(u)
		a.opened = u
	}
	a.open = nil
	winW, _ := c.Size()
	a.winW = winW
	if a.sidebarVisible {
		a.sideWidth = clampSidebar(a.sideWidth, winW)
	}
	root := ui.Box(c).Fill().Background(th.Background)
	a.moveStyle(root)
	a.shortcuts(c, root)
	full := onPixel(a.sideWidth+3, a.g.scale)
	open := float32(0)
	if a.sidebarVisible {
		open = 1
	}
	sh := a.shell()
	side := a.sideAt
	if d := a.activeTabDrag; d != nil {
		side = d.side
	} else {
		side = root.AnimateTo("sidebar", open, sidebarMotion)
		a.sideMoving = !root.Settled("sidebar")
	}
	a.sideAt = side
	slot := sh.slot(side, full, a.g.scale)
	if !a.comfortable() {
		a.viewCompact(c, root, th, winW, slot, full)
		return
	}
	var paneTop float32
	a.shellTop, paneTop = a.headerBand(c)
	_, winH := c.Size()
	if side > 0 {
		root.Row()
		root.Children(func() {
			a.sidebar(c, slot, full, winW)
			ui.Column(c).Grow(1).FillHeight().Children(func() {
				a.windowChrome(c, slot, slot)
				a.mainColumn(c, winW, winH, slot, paneTop, true)
			})
			a.sidebarControls(c)
			a.dialogView(c)
		})
		return
	}
	root.Column()
	root.Children(func() {
		a.windowChrome(c, slot, 0)
		ui.Row(c).Grow(1).FillWidth().Children(func() {
			ui.Box(c).Width(slot).FillHeight().Shrink(0).Background(th.Background).Label("sidebar-gutter")
			a.mainColumn(c, winW, winH, slot, paneTop, false)
		})
		a.sidebarControls(c)
		a.dialogView(c)
	})
}

func (a *App) viewCompact(c *ui.Context, root ui.Element, th *chrome.Theme, winW, slot, full float32) {
	root.Row()
	a.shellTop = topBarHeight(c)
	root.Children(func() {
		if slot > 0 {
			a.sidebar(c, slot, full, winW)
		}
		ui.Column(c).Grow(1).FillHeight().Background(th.Terminal.Background).Label("main-column").Children(func() {
			a.contentControls(c, slot)
			if a.snap == nil {
				a.disconnectedCard(c)
			} else {
				a.paneContainer(c, a.shell().paneWidth(winW, slot))
			}
			a.notes(c)
			if slot > 0 {
				a.sidebarGripEdge(c, winW)
			}
		})
		a.sidebarControls(c)
		a.dialogView(c)
	})
}

func topBarHeight(c *ui.Context) float32 {
	return max(tabBarHeight, c.TitleBar().Height)
}

func (a *App) contentControls(c *ui.Context, shown float32) {
	th := a.th
	padLeft := compactTabPad(c, th.IconButton, shown)
	bar := ui.Row(c).FillWidth().MinHeight(topBarHeight(c)).Padding(6, chrome.Step8, 6, padLeft).Gap(chrome.Step4).AlignItems(ui.Center).Background(th.TabBar).FocusGroup(ui.Horizontal).DragWindow().Label("tab-bar")
	if th.Divider.A > 0 {
		bar.BorderWidth(0, 0, gridLine(a.g.scale), 0).BorderColor(th.Divider)
	}
	bar.Children(func() {
		if a.snap != nil {
			tabs := a.snap.TabsOf(a.snap.FocusedWorkspaceID)
			for i, t := range tabs {
				a.tabButton(c, t, i, tabs)
			}
			a.tabEnd(c)
		}
		a.retiredTabDragSource(c)
	})
}

func windowChromeHeight(c *ui.Context, scale float32) float32 {
	return onPixel(max(windowChromeMin, c.TitleBar().Height), scale)
}

func compactTabPad(c *ui.Context, button, slot float32) float32 {
	return max(chrome.Step8, toggleX(c)+2*(button+chrome.Step4)-slot)
}

func tabLead(left, button, slot float32) float32 {
	safe := left + 2*button + chrome.Step4 + chrome.Step8
	if slot > safe {
		return slot
	}
	return safe
}

func (a *App) windowChrome(c *ui.Context, slot, origin float32) {
	h := a.shellTop
	th := a.th
	v := a.style()
	compact := slot + compactTabPad(c, th.IconButton, slot)
	lead := compact*(1-v) + tabLead(toggleX(c), th.IconButton, slot)*v - origin
	ui.Row(c).FillWidth().Height(h).Shrink(0).Background(th.Background).DragWindow().Label("window-chrome").Children(func() {
		a.headerTabs(c, h, lead)
	})
}

func (a *App) mainColumn(c *ui.Context, winW, winH, slot, gap float32, grip bool) {
	th := a.th
	outer := a.shell().outer
	pull := min(gap, 0)
	ui.Column(c).Grow(1).Height(winH-a.shellTop-outer-pull).Margin(pull, outer, outer, 0).
		Background(th.Background).Label("main-column").Children(func() {
		ui.Box(c).FillWidth().Height(max(gap, 0)).Shrink(0).Background(th.Background).Label("pane-gap")
		if a.snap == nil {
			a.disconnectedCard(c)
		} else {
			a.paneContainer(c, a.shell().paneWidth(winW, slot))
		}
		a.notes(c)
		if grip {
			a.sidebarGripEdge(c, winW)
		}
	})
}

func (a *App) notes(c *ui.Context) {
	paused := a.coreBlocked
	if a.navigationNote != "" || paused {
		ui.Column(c).Key(a.navigationGeneration).Absolute().Left(8).Right(8).Bottom(8).Children(func() {
			if a.navigationNote != "" {
				a.noteLine(c, a.navigationNote, func() { a.navigationNote = "" })
			}
			if paused {
				a.noteLine(c, navigationPaused, nil)
			}
		})
	}
	if a.coreOperationNote != "" {
		note := a.coreOperationNote
		a.noteLine(c, note, func() {
			if a.coreOperationNote == note {
				a.coreOperationNote = ""
			}
		})
	}
	if a.themes.note != "" {
		a.noteLine(c, a.themes.note, func() { a.themes.note = "" })
	}
}

func (a *App) noteLine(c *ui.Context, text string, dismiss func()) {
	th := a.th
	ui.Row(c).FillWidth().Padding(4, chrome.Step8).Gap(chrome.Step8).AlignItems(ui.Center).Label("note").Children(func() {
		ui.Text(c, text).FontSize(th.FontSizeSmall).TextColor(th.Danger).Grow(1).MinWidth(0).MaxLines(2)
		if dismiss != nil && a.iconButton(c, chrome.IconClose, "Dismiss").Clicked() {
			dismiss()
		}
	})
}

func (a *App) shortcuts(c *ui.Context, root ui.Element) {
	pane := ""
	if d := a.activeTabDrag; d != nil && c.Shortcut(0, ui.KeyEscape) {
		d.canceled = true
	}
	ws, tab := "", ""
	if a.snap != nil {
		pane, ws, tab = a.snap.FocusedPaneID, a.snap.FocusedWorkspaceID, a.snap.FocusedTabID
	}
	on := func(mods ui.Modifiers, key ui.Key, fn func()) {
		if root.Shortcut(mods, key) {
			fn()
		}
	}
	targetDo := func(id string, fn func(string)) func() {
		return func() {
			if a.coreCapture != nil || a.coreBlocked {
				a.cancelNavigation()
				return
			}
			if !a.coreTargetActionAllowed() {
				return
			}
			if id != "" {
				fn(id)
			}
		}
	}
	on(ui.Cmd, ui.KeyT, func() {
		a.NewTab(ws)
		a.returnFocus = true
	})
	on(ui.Cmd, ui.KeyN, func() {
		a.NewWorkspace()
		a.returnFocus = true
	})
	on(ui.Cmd, ui.KeyD, targetDo(pane, func(p string) {
		a.Split(p, "right")
		a.returnFocus = true
	}))
	on(ui.Cmd|ui.Shift, ui.KeyD, targetDo(pane, func(p string) {
		a.Split(p, "down")
		a.returnFocus = true
	}))
	on(ui.Cmd, ui.KeyW, targetDo(pane, a.ClosePane))
	on(ui.Cmd|ui.Shift, ui.KeyW, targetDo(tab, a.CloseTab))
	on(ui.Cmd|ui.Shift, ui.KeyEnter, targetDo(pane, a.ZoomPane))
	on(ui.Cmd, ui.KeyK, targetDo(pane, a.ClearPane))
	if runtime.GOOS == "darwin" && c.Shortcut(ui.Cmd, ui.KeyB) {
		a.toggleSidebar()
	}
	for _, d := range []struct {
		key ui.Key
		dir string
	}{{ui.KeyLeft, "left"}, {ui.KeyRight, "right"}, {ui.KeyUp, "up"}, {ui.KeyDown, "down"}} {
		dir := d.dir
		on(ui.Cmd|ui.Alt, d.key, targetDo(pane, func(p string) {
			a.FocusDirection(p, dir)
			a.returnFocus = true
		}))
		on(ui.Cmd|ui.Ctrl, d.key, targetDo(pane, func(p string) { a.ResizePane(p, dir) }))
	}
	if a.snap != nil {
		tabs := a.snap.TabsOf(ws)
		for i, k := range []ui.Key{ui.Key1, ui.Key2, ui.Key3, ui.Key4, ui.Key5, ui.Key6, ui.Key7, ui.Key8, ui.Key9} {
			if i < len(tabs) {
				id := tabs[i].ID
				on(ui.Cmd, k, func() {
					a.SelectTab(id)
					a.returnFocus = true
				})
			}
		}
		cur := -1
		for i, t := range tabs {
			if t.ID == tab {
				cur = i
			}
		}
		if cur >= 0 && len(tabs) > 1 {
			prev, next := tabs[(cur+len(tabs)-1)%len(tabs)].ID, tabs[(cur+1)%len(tabs)].ID
			on(ui.Cmd|ui.Shift, ui.KeyBracketLeft, func() {
				a.SelectTab(prev)
				a.returnFocus = true
			})
			on(ui.Cmd|ui.Shift, ui.KeyBracketRight, func() {
				a.SelectTab(next)
				a.returnFocus = true
			})
		}
	}
	zoom := func(d float32) func() {
		return func() {
			if d == 0 {
				a.fontSize = 0
			} else {
				a.fontSize = min(max(a.lookSize()+d, 6), 72)
			}
		}
	}
	on(ui.Cmd, ui.KeyEqual, zoom(1))
	on(ui.Cmd|ui.Shift, ui.KeyEqual, zoom(1))
	on(ui.Cmd, ui.KeyMinus, zoom(-1))
	on(ui.Cmd, ui.Key0, zoom(0))
}

func (a *App) lookSize() float32 {
	switch {
	case a.fontSize > 0:
		return a.fontSize
	case a.th != nil && a.th.FontMonoSize > 0:
		return a.th.FontMonoSize
	case a.look.Font.Size > 0:
		return a.look.Font.Size
	}
	return 13
}

func label(l string, n int) string {
	if l == "" {
		return fmt.Sprint(n)
	}
	return l
}

func (a *App) iconButton(c *ui.Context, icon *ui.SVG, label string) ui.Element {
	th := a.th
	b := ui.ButtonBase(c).Size(th.IconButton, th.IconButton).Padding(0).Center().Radius(th.Radius).Shrink(0).Label(label).Tooltip(label)
	ink := th.Secondary
	if b.Hovered() {
		b.Background(th.Row.Hover.Background)
		ink = th.Foreground
	}
	b.Children(func() {
		ui.Icon(c, icon).Size(th.Icon, th.Icon).TextColor(ink)
	})
	return b
}

func closeSlot(c *ui.Context, th *chrome.Theme, ink ui.Color, label string) bool {
	b := ui.ButtonBase(c).Size(th.Slot, th.Slot).Padding(0).Radius(th.Radius).Shrink(0).FocusRing(false).Label(label)
	if b.Hovered() {
		b.Background(th.Danger)
		ink = th.AccentForeground
	}
	b.Children(func() {
		ui.Icon(c, closeX).Size(th.Mark, th.Mark).TextColor(ink).Shrink(0)
	})
	return b.Clicked()
}

func (a *App) headerTabs(c *ui.Context, h, lead float32) {
	th := a.th
	bar := ui.Row(c).Grow(1).Height(h).Margin(0, a.shell().outer, 0, lead).Clip().Gap(chrome.Step4).Padding(0, chrome.Step8, 0, 0).AlignItems(ui.Center).Background(th.TabBar).FocusGroup(ui.Horizontal).DragWindow().Label("tab-bar")
	bar.Children(func() {
		if a.snap != nil {
			tabs := a.snap.TabsOf(a.snap.FocusedWorkspaceID)
			for i, t := range tabs {
				a.tabButton(c, t, i, tabs)
			}
			a.tabEnd(c)
		}
		a.retiredTabDragSource(c)
	})
}

func (a *App) retiredTabDragSource(c *ui.Context) {
	d := a.activeTabDrag
	if d == nil || !d.canceled {
		return
	}
	if a.snap != nil {
		for _, t := range a.snap.TabsOf(a.snap.FocusedWorkspaceID) {
			if t.ID == d.tabID {
				return
			}
		}
	}
	b := ui.ButtonBase(c).Key(d.tabID).Absolute().Size(0, 0).Disabled(true).
		PassThrough().Role(ui.RoleNone).Bind(&d.source).Drag(d)
	a.finishTabPress(c, b, d)
}

func (a *App) tabEnd(c *ui.Context) {
	newTab := a.iconButton(c, chrome.IconPlus, "New tab")
	if newTab.Clicked() {
		a.NewTab(a.snap.FocusedWorkspaceID)
		a.returnFocus = true
	}
	droppedEnd, hasDroppedEnd := ui.Drop[*tabDrag](newTab)
	dragOverEnd, isOverEnd := ui.DragOver[*tabDrag](newTab)
	if isOverEnd && a.validTabDrag(dragOverEnd) {
		tabs := a.snap.TabsOf(dragOverEnd.workspaceID)
		sourceIdx := -1
		for k, tab := range tabs {
			if tab.ID == dragOverEnd.tabID {
				sourceIdx = k
				break
			}
		}
		if sourceIdx != -1 && sourceIdx < len(tabs)-1 {
			newTab.DrawOver(func(p *ui.Painter, r ui.Rect) {
				p.Fill(ui.Rect{X: r.X - 2, Y: r.Y + 2, W: 2, H: r.H - 4}, a.th.Accent, 1)
			})
		}
	}
	if hasDroppedEnd && a.validTabDrag(droppedEnd) {
		tabs := a.snap.TabsOf(droppedEnd.workspaceID)
		sourceIdx := -1
		for k, tab := range tabs {
			if tab.ID == droppedEnd.tabID {
				sourceIdx = k
				break
			}
		}
		if sourceIdx != -1 && sourceIdx < len(tabs)-1 {
			a.MoveTab(droppedEnd.tabID, len(tabs))
		}
	}
}

type tabDrag struct {
	coreSession  *core.Session
	identities   map[string]coreVisitToken
	machine      *machine
	canceled     bool
	pointerClick bool
	held         bool
	style, side  float32
	source       ui.Handle
	machineID    string
	workspaceID  string
	tabID        string
}

func (a *App) finishTabPress(c *ui.Context, b ui.Element, d *tabDrag) {
	if a.activeTabDrag != d {
		return
	}
	_, _, d.held = b.Dragged()
	if !d.held {
		if b.Dragging() {
			d.canceled = true
		}
		a.activeTabDrag = nil
		c.Invalidate()
	}
}

func (a *App) cancelTabPress(ev ui.InputEvent) bool {
	if d := a.activeTabDrag; d != nil && d.held && ev.Kind == ui.InputKeyDown && ev.Key == ui.KeyEscape && ev.Mods == 0 {
		d.canceled = true
		return true
	}
	return false
}

func (a *App) checkTabDrag() {
	if d := a.activeTabDrag; d != nil && !a.validTabDrag(d) {
		d.canceled = true
	}
}

func (a *App) validTabDrag(d *tabDrag) bool {
	if d == nil || d.canceled || d.machine != a.machine || a.machine == nil || a.coreSession == nil || a.snap == nil {
		return false
	}
	if d.machineID != a.machine.id() || d.coreSession != a.coreSession {
		return false
	}
	if d.workspaceID != a.snap.FocusedWorkspaceID {
		return false
	}
	var t *core.Tab
	for _, w := range a.coreState.Layout.Workspaces {
		if w.ID == d.workspaceID {
			for i := range w.Tabs {
				if w.Tabs[i].ID == d.tabID {
					t = &w.Tabs[i]
					break
				}
			}
		}
	}
	if t != nil {
		state := a.coreSession.State()
		count := 0
		valid := true
		walkCorePanes(t.Root, func(p *core.Pane) {
			count++
			identity, ok := d.identities[p.ID]
			valid = valid && ok && identity.ref == p.Terminal && identity.program == state.Programs[p.Terminal.Address]
		})
		return valid && count == len(d.identities)
	}
	return false
}

func (a *App) tabButton(c *ui.Context, t presentation.Tab, i int, tabs []presentation.Tab) {
	on := t.ID == a.snap.FocusedTabID
	name := label(t.Label, t.Number)
	if t.Zoomed {
		name += " ⤢"
	}
	th := a.th
	status, description := a.activity(activityScope{tab: t.ID})
	source := map[string]coreVisitToken{}
	if tab := a.coreState.Layout.Tab(t.ID); tab != nil {
		walkCorePanes(tab.Root, func(p *core.Pane) {
			source[p.ID] = coreVisitToken{ref: p.Terminal, program: a.coreState.Programs[p.Terminal.Address]}
		})
	}
	origin := tabDrag{
		identities:  source,
		coreSession: a.coreSession,
		machine:     a.machine,
		machineID:   a.machine.id(),
		workspaceID: a.snap.FocusedWorkspaceID,
		tabID:       t.ID,
		held:        true,
		style:       a.style(),
		side:        a.sideAt,
	}
	b := ui.ButtonBase(c).Key(t.ID).Description(description).Label("tab/"+t.ID).MinWidth(th.TabWidth).MaxWidth(th.TabWidth).Height(th.IconButton).Padding(0, 10).Radius(th.Radius).Gap(6).AlignItems(ui.Center).Shrink(0).KeepFocus()
	drag := ui.Local(b, "tab-drag", func() tabDrag { return tabDrag{canceled: true} })
	b.Bind(&drag.source).HandleInput(func(ev ui.InputEvent) bool {
		a.mu.Lock()
		if a.cancelTabPress(ev) {
			a.mu.Unlock()
			return true
		}
		a.mu.Unlock()
		if ev.Button == 0 && (ev.Kind == ui.InputPointerDown || ev.Kind == ui.InputPointerUp) {
			a.mu.Lock()
			if ev.Kind == ui.InputPointerDown {
				source := drag.source
				*drag = origin
				drag.source = source
				a.activeTabDrag = drag
				a.checkTabDrag()
			} else {
				r := drag.source.Bounds(c)
				drag.pointerClick = ev.X >= 0 && ev.Y >= 0 && ev.X < r.W && ev.Y < r.H
				drag.held = false
			}
			a.mu.Unlock()
		}
		return false
	}).Drag(drag)
	if b.Dragging() {
		b.Opacity(0.4)
	}
	dropped, hasDropped := ui.Drop[*tabDrag](b)
	dragOver, isOver := ui.DragOver[*tabDrag](b)
	if isOver && a.validTabDrag(dragOver) {
		tabs := a.snap.TabsOf(dragOver.workspaceID)
		sourceIdx, targetIdx := -1, -1
		for k, tab := range tabs {
			if tab.ID == dragOver.tabID {
				sourceIdx = k
			}
			if tab.ID == t.ID {
				targetIdx = k
			}
		}
		if sourceIdx != -1 && targetIdx != -1 && sourceIdx != targetIdx {
			landingRight := sourceIdx < targetIdx
			b.DrawOver(func(p *ui.Painter, r ui.Rect) {
				x := r.X
				if landingRight {
					x = r.X + r.W - 2
				}
				p.Fill(ui.Rect{X: x, Y: r.Y + 2, W: 2, H: r.H - 4}, a.th.Accent, 1)
			})
		}
	}
	if hasDropped && a.validTabDrag(dropped) {
		tabs := a.snap.TabsOf(dropped.workspaceID)
		sourceIdx, targetIdx := -1, -1
		for k, tab := range tabs {
			if tab.ID == dropped.tabID {
				sourceIdx = k
			}
			if tab.ID == t.ID {
				targetIdx = k
			}
		}
		if sourceIdx != -1 && targetIdx != -1 && sourceIdx != targetIdx {
			insertIndex := targetIdx
			if sourceIdx < targetIdx {
				insertIndex = targetIdx + 1
			}
			if insertIndex != sourceIdx && insertIndex != sourceIdx+1 {
				a.MoveTab(dropped.tabID, insertIndex)
			}
		}
	}
	over := b.Hovered()
	st := th.Tab.Pick(on, over, a.windowFocused)
	st.Apply(b)
	col := st.Foreground
	if col.A == 0 {
		col = th.Secondary
	}
	id := t.ID
	b.Children(func() {
		ui.Text(c, name).FontSize(th.Tab.FontSize).FontWeight(st.Weight).TextColor(col).Grow(1).MinWidth(0).SingleLine()
		if over {
			if closeSlot(c, th, col, "close/"+id) {
				a.CloseTab(id)
			}
		} else {
			paintActivity(c, th, status)
		}
	})
	clicks := b.Clicks()
	if drag.pointerClick && !a.validTabDrag(drag) {
		clicks--
	}
	drag.pointerClick = false
	if clicks > 0 {
		a.SelectTab(id)
		a.returnFocus = true
	}
	a.finishTabPress(c, b, drag)
	b.ContextMenu(func(m *ui.Menu) {
		if m.Item("Rename…").Chosen() {
			a.ask("Rename tab", t.Label, false, func(v string) { a.RenameTab(id, v) })
		}
		if m.Item("Move left").Disabled(i == 0).Chosen() {
			a.MoveTab(id, i-1)
		}
		if m.Item("Move right").Disabled(i == len(tabs)-1).Chosen() {
			a.MoveTab(id, i+2)
		}
		m.Separator()
		if m.Item("Close tab").Chosen() {
			a.CloseTab(id)
		}
	})
}

func (a *App) paneContainer(c *ui.Context, w float32) {
	th := a.th
	box := ui.Box(c).Grow(1).FillWidth().Label("pane-container")
	th.Container.Apply(box)
	if a.comfortable() {
		box.Background(th.Background)
	} else {
		box.Background(th.Terminal.Background)
	}
	box.Children(func() { a.corePanes(c) })
}

const inactiveVeil = 0.06

var paneActions = map[string]struct {
	icon *ui.SVG
	tip  string
	do   func(a *App, id string)
}{
	"split-right": {chrome.IconSplitRight, "Split right", func(a *App, id string) { a.Split(id, "right") }},
	"split-down":  {chrome.IconSplitDown, "Split down", func(a *App, id string) { a.Split(id, "down") }},
	"zoom":        {chrome.IconZoom, "Zoom pane", (*App).ZoomPane},
	"close-pane":  {chrome.IconClose, "Close pane", (*App).ClosePane},
}

func (a *App) paneMenu(m *ui.Menu) {
	id := a.menuPane
	if id == "" {
		return
	}
	if m.Item("Open scrollback in editor").Chosen() {
		a.EditScrollback(id)
	}
	if m.Item("Rename pane").Chosen() {
		a.ask("Rename pane", "", false, func(v string) { a.RenamePane(id, v) })
	}
	if m.Item("Split right").Chosen() && a.coreTargetActionAllowed() {
		a.Split(id, "right")
		a.returnFocus = true
	}
	if m.Item("Split down").Chosen() && a.coreTargetActionAllowed() {
		a.Split(id, "down")
		a.returnFocus = true
	}
	if m.Item("Zoom").Chosen() && a.coreTargetActionAllowed() {
		a.zoomPane(id)
	}
	if m.Item("Send right-clicks to pane").Checked(a.rightToPane[id]).Chosen() {
		a.SetRightClicks(id, !a.rightToPane[id])
	}
	if m.Item("Close pane").Chosen() && a.coreTargetActionAllowed() {
		a.ClosePane(id)
	}
}

func (a *App) zoomPane(id string) {
	zoomed := false
	if a.snap != nil && id == a.snap.FocusedPaneID {
		for _, t := range a.snap.Tabs {
			if t.ID == a.snap.FocusedTabID {
				zoomed = t.Zoomed
			}
		}
	}
	mode := "on"
	if zoomed {
		mode = "off"
	}
	a.ZoomPaneMode(id, mode)
}

func (a *App) disconnectedCard(c *ui.Context) {
	th := a.th
	ui.Column(c).Grow(1).FillWidth().Center().Gap(chrome.Step8).Background(th.Container.Background).Label("disconnected").Children(func() {
		title, action := "Not connected to herdr-core", "Reconnect"
		if a.coreMismatch {
			title, action = "herdr-core version mismatch", "Retry"
		}
		if a.remote != nil {
			title = "Not connected to " + a.label()
		}
		ui.Text(c, title).FontSize(th.FontSize).FontWeight(600).TextColor(th.Foreground)
		if a.err != "" {
			ui.Text(c, a.err).FontSize(th.FontSizeSmall).TextColor(th.Secondary).MaxLines(3).MaxWidth(420)
		}
		if ui.PrimaryButton(c, action).Margin(chrome.Step8, 0, 0, 0).Clicked() {
			a.Reconnect()
		}
	})
}
