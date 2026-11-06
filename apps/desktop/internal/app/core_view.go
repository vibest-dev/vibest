package app

import (
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
	"reflect"
	"slices"
	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"
)

type coreSplitDrag struct {
	active, canceled bool
	value            float64
	session          *core.Session
	version          uint64
	tab              string
}

type coreLook struct {
	font  terminal.Font
	theme *terminal.Theme
}

func (a *App) corePanes(c *ui.Context) {
	defer func() { a.coreEditorClick = "" }()
	a.coreCaptureView(c)
	a.coreFocus()
	a.coreFocusedFrame = false
	clear(a.coreBounds)
	root := a.coreState.Layout.Tab(a.coreSelection.Tab)
	if root == nil {
		ui.Column(c).Grow(1).FillWidth().Center().Gap(chrome.Step8).Label("empty-core-layout").Children(func() {
			ui.Text(c, "No workspaces in this Core").TextColor(a.th.Secondary)
			if ui.PrimaryButton(c, "New workspace").Clicked() {
				a.NewWorkspace()
			}
		})
		return
	}
	node := root.Root
	if a.coreSelection.Zoom != "" {
		walkCorePanes(node, func(p *core.Pane) {
			if p.ID == a.coreSelection.Zoom {
				node = &core.Split{Pane: p}
			}
		})
	}
	area := ui.Box(c).Key("core-panes").Grow(1).FillWidth().MinHeight(0).Clip().Label("Panes")
	area.Draw(func(p *ui.Painter, r ui.Rect) {
		a.mu.Lock()
		changed := a.g.scale != p.Scale()
		a.g.scale = p.Scale()
		a.paneBox = r
		a.mu.Unlock()
		if changed {
			a.invalidate()
		}
	})
	area.Children(func() { a.coreSplitView(c, node, root.ID, nil) })
	if a.coreFocusedFrame || a.coreBlocked && a.coreCapture == nil {
		a.returnFocus = false
	}
}
func (a *App) coreSplitView(c *ui.Context, n *core.Split, tab string, path []bool) {
	if n == nil {
		return
	}
	if n.Pane != nil {
		a.corePaneView(c, n.Pane)
		return
	}
	box := ui.Box(c).Fill().MinWidth(0).MinHeight(0)
	if n.Axis == "x" {
		box.Row()
	} else {
		box.Column()
	}
	h := ui.Local(box, "bounds", func() ui.Handle { return ui.Handle{} })
	box.Bind(h)
	drag := ui.Local(box, "ratio", func() coreSplitDrag { return coreSplitDrag{} })
	if drag.active && (drag.session != a.coreSession || drag.version != a.coreState.Version || drag.tab != tab || !a.windowFocused) {
		drag.active = false
		drag.canceled = true
	}
	ratio := n.Ratio
	if drag.active {
		ratio = drag.value
	}
	box.Children(func() {
		first := ui.Box(c).Grow(float32(ratio)).Basis(0).MinWidth(0).MinHeight(0).Clip()
		if n.Axis == "x" {
			first.FillHeight()
		} else {
			first.FillWidth()
		}
		first.Children(func() { a.coreSplitView(c, n.First, tab, append(slices.Clone(path), false)) })
		grip := ui.Box(c).Shrink(0).KeepFocus().Label("core-split-grip")
		gap := a.shell().cardGap(a.g.scale)
		if n.Axis == "x" {
			grip.Width(gap).FillHeight().Cursor(ui.CursorResizeEW)
		} else {
			grip.Height(gap).FillWidth().Cursor(ui.CursorResizeNS)
		}
		dx, dy, held := grip.Dragged()
		if held && !drag.canceled {
			if !drag.active {
				*drag = coreSplitDrag{active: true, value: n.Ratio, session: a.coreSession, version: a.coreState.Version, tab: tab}
			}
			bounds := h.Bounds(c)
			extent, delta := bounds.W, dx
			if n.Axis != "x" {
				extent, delta = bounds.H, dy
			}
			if extent > 0 {
				drag.value = max(.05, min(.95, drag.value+float64(delta/extent)))
				c.Invalidate()
			}
		}
		if _, _, ended := grip.DragEnded(); ended {
			if drag.active && !drag.canceled {
				a.coreSetRatio(tab, path, float32(drag.value))
			}
			*drag = coreSplitDrag{}
		} else if !held {
			*drag = coreSplitDrag{}
		}
		second := ui.Box(c).Grow(float32(1 - ratio)).Basis(0).MinWidth(0).MinHeight(0).Clip()
		if n.Axis == "x" {
			second.FillHeight()
		} else {
			second.FillWidth()
		}
		second.Children(func() { a.coreSplitView(c, n.Second, tab, append(slices.Clone(path), true)) })
	})
}
func (a *App) corePaneView(c *ui.Context, p *core.Pane) {
	selected := p.ID == a.coreSelection.Pane
	card := ui.Column(c).Key(p.ID).Fill().MinWidth(0).MinHeight(0).Clip().Radius(a.shell().cardRadius(a.g.scale)).Background(a.th.Terminal.Background).Label("pane/" + p.ID)
	bounds := ui.Local(card, "bounds", func() ui.Handle { return ui.Handle{} })
	card.Bind(bounds)
	a.coreBounds[p.ID] = bounds.Bounds(c)
	card.Children(func() {
		header := ui.Row(c).Height(headH).Shrink(0).Padding(headPad, sides).Gap(headGap).AlignItems(ui.Center).Label("pane-header/" + p.ID)
		header.ContextMenu(func(m *ui.Menu) { was := a.menuPane; a.menuPane = p.ID; a.paneMenu(m); a.menuPane = was })
		header.Children(func() {
			color := a.th.Secondary
			if selected && a.windowFocused {
				color = a.th.Accent
			}
			ui.Text(c, paneTitle(a.snap, p.ID)).Tooltip("Core: " + p.Terminal.CoreID + "\nTerminal: " + p.Terminal.Address).Grow(1).MinWidth(0).SingleLine().FontSize(a.th.FontSizeSmall).TextColor(color)
			for _, kind := range []string{"split-right", "split-down", "zoom", "close-pane"} {
				action := paneActions[kind]
				b := a.iconButton(c, action.icon, kind+"/"+p.ID).Size(headButtonSize, headButtonSize).Tooltip(action.tip)
				if b.Clicked() {
					action.do(a, p.ID)
					a.returnFocus = true
				}
			}
		})
		ui.Box(c).Grow(1).FillWidth().MinHeight(0).Padding(0, sidePad(a.g.scale), a.shell().bottomPad(a.g.scale), sidePad(a.g.scale)).Clip().Children(func() {
			opts := a.paneLook(a.th)
			opts.Padding = terminal.Padding{X: -1, Y: -1}
			opts.Theme = a.th.Terminal
			opts.Font.Size = a.lookSize()
			opts.Font.Antialiased = !opts.Font.Thicken
			a.coreAttach(p.ID, opts)
			view := a.coreViews[p.ID]
			if view == nil {
				message := coreWaiting(p.Terminal.Address)
				if err := a.coreErrors[p.ID]; err != "" {
					message = err
				}
				ui.Text(c, message).Padding(chrome.Step8).TextColor(a.th.Secondary).MaxLines(4)
				return
			}
			a.lookedAt(p.Terminal.Address)
			style := ui.Local(card, "terminal-look", func() coreLook { return coreLook{opts.Font, a.th.Terminal} })
			if style.theme != a.th.Terminal {
				view.VT.SetTheme(a.th.Terminal, nil)
				style.theme = a.th.Terminal
			}
			if !reflect.DeepEqual(style.font, opts.Font) {
				view.VT.SetFont(opts.Font)
				style.font = opts.Font
			}
			e := view.View(c).Fill().Label("terminal/" + p.ID)
			if selected && a.coreCapture == nil && !a.coreBlocked && a.dialog == nil && a.nativeDialog == nil {
				e.AutoFocus()
				if a.returnFocus {
					e.Focus()
					a.coreFocusedFrame = true
				}
			}
			if e.Clicked() && a.coreEditorClick != p.ID {
				if !selected || a.coreBlocked || a.coreCapture != nil || !view.InputReady() {
					a.ShowPane(p.ID)
				} else {
					a.acknowledgeCoreVisit(a.captureCoreVisit(activityScope{pane: p.ID}))
				}
			}
			if e.Focused() && a.coreSelection.Pane != p.ID && !a.returnFocus && a.dialog == nil && a.nativeDialog == nil {
				a.coreNavigate(func(sel *core.Selection, l *core.Layout) error { return sel.SelectPane(l, p.ID) })
			}
			if selected && a.windowFocused && a.dialog == nil && a.nativeDialog == nil {
				message := ""
				if err := view.InputError(); err != nil {
					message = err.Error()
				} else if !view.InputReady() {
					message = "Input paused until this terminal has a classified, fitted frame"
				}
				select {
				case <-view.VT.Done():
					message = "Terminal stream ended; input unavailable"
				default:
				}
				if message != "" {
					ui.Text(c, message).Absolute().Left(chrome.Step8).Top(chrome.Step8).TextColor(a.th.Secondary).Background(a.th.Terminal.Background).MaxLines(3).PassThrough()
				}
			}
			if !selected && a.coreSelection.Zoom == "" {
				ui.Box(c).Absolute().Left(sidePad(a.g.scale)).Right(sidePad(a.g.scale)).Top(0).Bottom(a.shell().bottomPad(a.g.scale)).Background(a.th.Foreground.Alpha(inactiveVeil)).PassThrough().Role(ui.RoleNone).Label("inactive/" + p.ID)
			}
		})
		if a.comfortable() {
			ui.Box(c).Absolute().Fill().Radius(a.shell().cardRadius(a.g.scale)).Border(gridLine(a.g.scale), a.th.Border).PassThrough()
		}
	})
}
