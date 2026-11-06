package app

import (
	"time"

	"github.com/egoist/mygo/plugins/glass"
	"github.com/egoist/mygo/ui"
)

const (
	menuRadius          float32 = 12
	menuInset           float32 = 5
	menuRowHeight       float32 = 28
	menuRowPadX         float32 = 8
	menuRowRadius       float32 = 8
	menuFont            float32 = 13
	menuShortcut        float32 = 11
	menuMark            float32 = 14
	menuRowGap          float32 = 12
	menuMinWidth        float32 = 160
	menuMaxWidth        float32 = 228
	menuEdge            float32 = 8
	menuAnchorGap       float32 = 6
	menuSubmenuGap      float32 = 4
	menuTravel          float32 = 8
	menuEnter                   = 170 * time.Millisecond
	menuSeparatorMargin         = 4
)

func menuSkin(c *ui.Context) ui.MenuPainter {
	return ui.MenuPainter{
		Panel:     func(panel ui.Element, info ui.MenuPaint) { paintMenuPanel(c, panel, info) },
		Item:      func(row ui.Element, it ui.MenuPaintItem) { paintMenuItem(c, row, it) },
		Separator: func() { paintMenuSeparator(c) },
	}
}

func paintMenuPanel(c *ui.Context, panel ui.Element, info ui.MenuPaint) {
	th := c.Theme()
	ink := th.Text
	panel.MinWidth(menuMinWidth).MaxWidth(menuMaxWidth).Padding(menuInset).Radius(menuRadius).Clip()
	panel.Border(1, ink.Alpha(0.1)).AttachEdgeMargin(menuEdge).FocusRing(false)
	panel.Shadow(0, 20, 25, -5, ui.RGBA(0, 0, 0, float32(26)/255))
	panel.Shadow(0, 8, 10, -6, ui.RGBA(0, 0, 0, float32(26)/255))
	if _, h := c.Size(); h > menuEdge*2 {
		panel.MaxHeight(h - menuEdge*2)
	}
	if th.Dark && !c.Preferences().ReduceTransparency {
		panel.Material(glass.Blur{Radius: 24})
		ui.Box(c).Absolute().Left(0).Top(0).Right(0).Bottom(0).Background(ink.Alpha(0.02)).PassThrough()
	} else {
		panel.Background(th.Surface)
	}
	if info.Level > 0 {
		panel.MarginStart(menuSubmenuGap)
	} else {
		panel.Margin(menuAnchorGap, 0, 0, 0)
	}
	if !menuAnimates(c, info) {
		return
	}
	from := &ui.Motion{Opacity: 0, Y: -menuTravel, Flip: true}
	if info.Level > 0 {
		from = &ui.Motion{Opacity: 0, X: -menuTravel, Flip: true}
	}
	panel.Transition(ui.ElementTransition{
		Duration:     menuEnter,
		Ease:         ui.CubicBezier(0.16, 1, 0.3, 1),
		Colors:       true,
		Enter:        from,
		ExitDuration: -1,
	})
}

func menuAnimates(c *ui.Context, info ui.MenuPaint) bool {
	if c.Preferences().ReduceMotion || info.Edit || menuInstantTrigger(info) {
		return false
	}
	return true
}

func menuInstantTrigger(info ui.MenuPaint) bool {
	if info.TriggerLabel == "Terminal" {
		return true
	}
	switch info.TriggerWidget {
	case "TextInput", "TextArea", "TextInputBuffer", "TextAreaBuffer", "EditableText":
		return true
	default:
		return false
	}
}

func paintMenuItem(c *ui.Context, row ui.Element, it ui.MenuPaintItem) {
	th := c.Theme()
	ink := th.Text
	row.Height(menuRowHeight).Padding(0, menuRowPadX).Radius(menuRowRadius).Gap(menuRowGap).AlignItems(ui.Center).Shrink(0)
	switch {
	case !it.Enabled:
		ink = th.Text.Alpha(0.3)
	case row.Highlighted():
		row.Background(th.Text.Alpha(0.1))
	}
	row.TextColor(ink)
	row.Children(func() {
		if it.Marks {
			slot := ui.Box(c).Size(menuMark, menuMark).Shrink(0)
			if it.Checked {
				slot.Children(func() {
					ui.Text(c, "✓").FontSize(menuMark).TextColor(ink)
				})
			}
		}
		ui.Text(c, it.Label).FontSize(menuFont).SingleLine().Grow(1).MinWidth(0)
		if it.Shortcut != "" {
			ui.Text(c, it.Shortcut).FontSize(menuShortcut).TextColor(th.Text.Alpha(0.4)).Shrink(0)
		}
		if it.Submenu {
			ui.Text(c, "›").FontSize(menuMark).TextColor(th.Text.Alpha(0.5)).Shrink(0)
		}
	})
}

func paintMenuSeparator(c *ui.Context) {
	ui.Box(c).Height(1).Margin(menuSeparatorMargin, 0).Background(c.Theme().Text.Alpha(0.1)).Shrink(0)
}
