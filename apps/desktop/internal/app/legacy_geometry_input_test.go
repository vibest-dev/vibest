package app

import (
	"math"

	"strings"

	"vibest-desktop/internal/herdr"

	"github.com/egoist/mygo/ui"
)

var legacySpecialKeys = map[ui.Key]int{
	ui.KeyEnter: herdr.KeyEnter, ui.KeyEscape: herdr.KeyEsc, ui.KeyBackspace: herdr.KeyBackspace,
	ui.KeyTab: herdr.KeyTab, ui.KeyDelete: herdr.KeyDelete, ui.KeyInsert: herdr.KeyInsert,
	ui.KeyHome: herdr.KeyHome, ui.KeyEnd: herdr.KeyEnd, ui.KeyPageUp: herdr.KeyPageUp,
	ui.KeyPageDown: herdr.KeyPageDown, ui.KeyLeft: herdr.KeyLeft, ui.KeyRight: herdr.KeyRight,
	ui.KeyUp: herdr.KeyUp, ui.KeyDown: herdr.KeyDown,
}

var functionKeys = []ui.Key{ui.KeyF1, ui.KeyF2, ui.KeyF3, ui.KeyF4, ui.KeyF5, ui.KeyF6,
	ui.KeyF7, ui.KeyF8, ui.KeyF9, ui.KeyF10, ui.KeyF11, ui.KeyF12}

func herdrMods(m ui.Modifiers) uint8 {
	var out uint8
	if m&ui.Shift != 0 {
		out |= herdr.ModShift
	}
	if m&ui.Ctrl != 0 {
		out |= herdr.ModCtrl
	}
	if m&ui.Alt != 0 {
		out |= herdr.ModAlt
	}
	return out
}

func lineEdit(ev ui.InputEvent) (herdr.Key, bool) {
	k := herdr.Key{Repeat: ev.Repeat}
	switch {
	case ev.Mods == ui.Super && ev.Key == ui.KeyLeft:
		k.Code, k.Char, k.Mods = herdr.KeyChar, 'a', herdr.ModCtrl
	case ev.Mods == ui.Super && ev.Key == ui.KeyRight:
		k.Code, k.Char, k.Mods = herdr.KeyChar, 'e', herdr.ModCtrl
	case ev.Mods == ui.Super && ev.Key == ui.KeyBackspace:
		k.Code, k.Char, k.Mods = herdr.KeyChar, 'u', herdr.ModCtrl
	case ev.Mods == ui.Alt && ev.Key == ui.KeyLeft:
		k.Code, k.Char, k.Mods = herdr.KeyChar, 'b', herdr.ModAlt
	case ev.Mods == ui.Alt && ev.Key == ui.KeyRight:
		k.Code, k.Char, k.Mods = herdr.KeyChar, 'f', herdr.ModAlt
	case ev.Mods == ui.Shift && ev.Key == ui.KeyEnter:
		k.Code, k.Mods = herdr.KeyEnter, herdr.ModAlt
	default:
		return herdr.Key{}, false
	}
	return k, true
}

func keyEvent(ev ui.InputEvent) (herdr.Key, bool) {
	if k, ok := lineEdit(ev); ok {
		return k, true
	}
	k := herdr.Key{Mods: herdrMods(ev.Mods), Repeat: ev.Repeat}
	if code, ok := legacySpecialKeys[ev.Key]; ok {
		k.Code = code
		if code == herdr.KeyTab && ev.Mods&ui.Shift != 0 {
			k.Code = herdr.KeyBackTab
		}
		return k, true
	}
	for i, f := range functionKeys {
		if ev.Key == f {
			k.Code, k.F = herdr.KeyF, uint8(i+1)
			return k, true
		}
	}
	if r, ok := keyRunes[ev.Key]; ok && ev.Mods&ui.Ctrl != 0 {
		k.Code, k.Char = herdr.KeyChar, r
		return k, true
	}
	return k, false
}

type interaction struct {
	preedit        string
	sel            *selection
	drag           *herdr.SurfaceSplit
	grabX, grabY   float32
	mouse          *mouseGesture
	wheel          float32
	hoverX, hoverY float32
}

type shown struct {
	s           *herdr.Surface
	pane, tab   string
	cw, ch      float32
	w, h, scale float32
	ox, oy      float32
	tooSmall    bool
	fits        bool
	pending     bool
	places      []panePlace
	lines       []paneLine
	rightToPane map[string]bool
	keyTo       *herdr.Target
}

type openPaneMenu struct {
	id   string
	x, y float32
}

type (
	effect    any
	sendInput struct {
		to     herdr.Target
		events []herdr.InputEvent
	}
	focusPane string
	openLink  struct {
		pane     string
		row, col int
	}
	copyText string
	pasteTo  struct {
		to    herdr.Target
		paths []string
		quote pathQuote
	}
)

const (
	wheelNotch = 40
	wheelRows  = 3
)

func send(t herdr.Target, events ...herdr.InputEvent) []effect {
	return []effect{sendInput{t, events}}
}

func (v shown) target() herdr.Target {
	if v.keyTo != nil {
		return *v.keyTo
	}
	if v.s != nil && v.s.Popup != nil {
		return herdr.Target{ID: v.s.Popup.TerminalID, Popup: true}
	}
	return herdr.Target{ID: v.pane}
}

func (v shown) cell(x, y float32) (int, int) {
	return int((x - v.ox) / v.cw), int((y - v.oy) / v.ch)
}

func (v shown) paneShift(p herdr.SurfacePane) (dx, dy float32) {
	pl, _ := v.place(p.ID)
	return pl.term.X - float32(p.Inner.X)*v.cw, pl.term.Y - float32(p.Inner.Y)*v.ch
}

func (v shown) region(px, py float32) (region, int, int, bool) {
	if v.tooSmall || v.s == nil {
		return region{}, 0, 0, false
	}
	if pp := v.s.Popup; pp != nil {
		x, y := v.cell(px, py)
		pr := popupRect(v.s)
		if pp.TerminalID == "" || !pr.Contains(x, y) {
			return region{}, 0, 0, false
		}
		return region{target: herdr.Target{ID: pp.TerminalID, Popup: true}, inner: pr, mouse: pp.MouseReporting, dx: v.ox, dy: v.oy}, x, y, true
	}
	for _, pl := range v.places {
		if !pl.card.Contains(px, py) {
			continue
		}
		p := pl.pane
		if p.ID == "" || !v.showsPane(p.ID) {
			return region{}, 0, 0, false
		}
		r := region{target: herdr.Target{ID: p.ID}, inner: p.Inner, mouse: p.MouseReporting, pane: p}
		r.dx, r.dy = v.paneShift(*p)
		return r, v.col(px, r.dx), v.row(py, r.dy), true
	}
	return region{}, 0, 0, false
}

func (v shown) col(px, dx float32) int { return int(math.Floor(float64((px - dx) / v.cw))) }
func (v shown) row(py, dy float32) int { return int(math.Floor(float64((py - dy) / v.ch))) }

type region struct {
	target herdr.Target
	inner  herdr.Rect
	mouse  bool
	pane   *herdr.SurfacePane
	dx, dy float32
}

func (r region) cell(x, y int) (col, row int) { return cellIn(r.inner, x, y) }

func cellIn(in herdr.Rect, x, y int) (col, row int) {
	return min(max(x-in.X, 0), in.Width-1), min(max(y-in.Y, 0), in.Height-1)
}

func (in *interaction) handle(ev ui.InputEvent, v shown) (bool, []effect) {
	if v.cw == 0 {
		return false, nil
	}
	switch ev.Kind {
	case ui.InputKeyDown:
		switch {
		case ev.Mods == ui.Super && ev.Key == ui.KeyC:
			return in.copy(v)
		case ev.Mods == ui.Super && ev.Key == ui.KeyV:
			return true, []effect{pasteTo{to: v.target()}}
		case ev.Mods&ui.Super != 0:
			if _, ok := lineEdit(ev); !ok {
				return false, nil
			}
		}
		k, ok := keyEvent(ev)
		if !ok {
			return true, nil
		}
		in.sel = nil
		return true, send(v.target(), k)
	case ui.InputKeyUp:
		return ev.Mods&ui.Super == 0, nil
	case ui.InputText:
		in.preedit, in.sel = "", nil
		return true, send(v.target(), herdr.Text(ev.Text))
	case ui.InputCompose:
		in.preedit = ev.Text
		return true, nil
	case ui.InputCommand:
		switch ev.Text {
		case "copy":
			return in.copy(v)
		case "paste":
			return true, []effect{pasteTo{to: v.target()}}
		}
		return false, nil
	case ui.InputPointerDown:
		return in.pointerDown(ev, v)
	case ui.InputPointerMove:
		return in.pointerMove(ev, v)
	case ui.InputPointerUp:
		return in.pointerUp(ev)
	case ui.InputScroll:
		return in.scroll(ev, v)
	}
	return false, nil
}

func (in *interaction) copy(v shown) (bool, []effect) {
	if in.sel == nil || v.s == nil {
		return false, nil
	}
	p := paneByID(v.s, in.sel.pane)
	if p == nil {
		return true, []effect{copyText("")}
	}
	sc, ok := in.sel.project(p)
	if !ok {
		return true, []effect{copyText("")}
	}
	return true, []effect{copyText(sc.text(&v.s.Frame))}
}

func (in *interaction) pointerDown(ev ui.InputEvent, v shown) (bool, []effect) {
	s := v.s
	if pl, ok := v.headerAt(ev.X, ev.Y); ok && pl.pane != nil {
		in.sel = nil
		in.drag = nil
		for _, b := range headButtons(pl) {
			if b.r.Contains(ev.X, ev.Y) {
				return false, nil
			}
		}
		if ev.Button == 1 && !(v.rightToPane[pl.pane.ID] && ev.Mods == 0) {
			return false, []effect{openPaneMenu{pl.pane.ID, ev.X, ev.Y}}
		}
		var fx []effect
		if ev.Button == 0 && !pl.pane.Focused {
			fx = append(fx, focusPane(pl.pane.ID))
		}
		return true, fx
	}
	in.sel = nil
	if sp := v.splitAt(ev.X, ev.Y); sp != nil && ev.Button == 0 {
		in.drag, in.grabX, in.grabY = sp, ev.X, ev.Y
		return true, nil
	}
	r, col, row, ok := v.region(ev.X, ev.Y)
	if !ok {
		return s != nil && s.Popup != nil, nil
	}
	var fx []effect
	if r.pane != nil && !r.pane.Focused {
		fx = append(fx, focusPane(r.pane.ID))
	}
	col, row = r.cell(col, row)
	switch {
	case r.pane != nil && ev.Button == 0 && ev.Mods&ui.Super != 0:
		fx = append(fx, openLink{r.pane.ID, row, col})
	case r.pane != nil && ev.Button == 1 && !(v.rightToPane[r.pane.ID] && ev.Mods == 0):
		return false, []effect{openPaneMenu{r.pane.ID, ev.X, ev.Y}}
	case r.mouse && ev.Mods&ui.Shift == 0:
		fx = append(fx, send(r.target, herdr.Mouse{Kind: herdr.MouseDown, Button: ev.Button, Col: col, Row: row, Mods: herdrMods(ev.Mods)})...)
		in.mouse = &mouseGesture{region: r, button: ev.Button, col: col, row: row}
	case r.pane != nil && ev.Button == 0:
		cx, cy := r.inner.X+col, r.inner.Y+row
		if off, rows, ok := scrollParts(r.pane); ok {
			from := fromBottom(cy, r.inner.Y, off, rows)
			in.sel = &selection{
				pane: r.pane.ID, ax: cx, hx: cx,
				ayFrom: from, hyFrom: from, sent: -1,
			}
			if ev.Clicks == 2 {
				in.sel.word(&s.Frame, r.inner, cy)
			}
		}
	default:
		if ev.Button == 1 && r.pane != nil {
			return true, fx
		}
		return r.pane == nil, fx
	}
	return true, fx
}

func (in *interaction) pointerMove(ev ui.InputEvent, v shown) (bool, []effect) {
	in.hoverX, in.hoverY = ev.X, ev.Y
	switch {
	case in.drag != nil:
		sp := in.drag
		travel, origin, length, cell := ev.X-in.grabX, sp.Area.X, sp.Area.Width, v.cw
		if !sp.Across {
			travel, origin, length, cell = ev.Y-in.grabY, sp.Area.Y, sp.Area.Height, v.ch
		}
		if length > 0 && v.tab != "" {
			cut := float32(sp.Pos-origin) + float32(math.Round(float64(travel/cell)))
			return true, []effect{ratio{v.tab, sp.Path, min(max(cut/float32(length), 0.1), 0.9)}}
		}
	case in.mouse != nil:
		m := in.mouse
		if col, row := m.cell(v.col(ev.X, m.dx), v.row(ev.Y, m.dy)); col != m.col || row != m.row {
			m.col, m.row = col, row
			return true, send(m.target, herdr.Mouse{Kind: herdr.MouseDrag, Button: m.button, Col: col, Row: row, Mods: herdrMods(ev.Mods)})
		}
	case in.sel != nil && ev.Button == 0:
		p := paneByID(v.s, in.sel.pane)
		if p == nil {
			return true, nil
		}
		dx, dy := v.paneShift(*p)
		y := v.row(ev.Y, dy)
		col, row := cellIn(p.Inner, v.col(ev.X, dx), y)
		in.sel.hx = p.Inner.X + col
		in.sel.delta = 0
		if y < p.Inner.Y {
			in.sel.delta = 1
		} else if y >= p.Inner.Y+p.Inner.Height {
			in.sel.delta = -1
		}
		if in.sel.delta == 0 {
			if off, rows, ok := scrollParts(p); ok {
				in.sel.hyFrom = fromBottom(p.Inner.Y+row, p.Inner.Y, off, rows)
			}
			in.sel.sent = -1
		}
		return true, nil
	default:
		return false, nil
	}
	return true, nil
}

func (in *interaction) pointerUp(ev ui.InputEvent) (bool, []effect) {
	switch {
	case in.drag != nil:
		in.drag = nil
	case in.mouse != nil:
		m := in.mouse
		in.mouse = nil
		return true, send(m.target, herdr.Mouse{Kind: herdr.MouseUp, Button: m.button, Col: m.col, Row: m.row, Mods: herdrMods(ev.Mods)})
	case in.sel != nil:
		in.sel.delta = 0
		if in.sel.ax == in.sel.hx && in.sel.ayFrom == in.sel.hyFrom {
			in.sel = nil
		}
	default:
		return false, nil
	}
	return true, nil
}

func (in *interaction) scroll(ev ui.InputEvent, v shown) (bool, []effect) {
	if v.ch == 0 {
		return false, nil
	}
	r, x, y, ok := v.region(ev.X, ev.Y)
	if !ok {
		return false, nil
	}
	rows := in.takeRows(ev, v.ch)
	if rows == 0 {
		return true, nil
	}
	col, row := r.cell(x, y)
	return true, wheelEvent(r, col, row, rows, ev.Mods)
}

func (in *interaction) takeRows(ev ui.InputEvent, ch float32) int {
	if !ev.Precise {
		if ev.DY < 0 {
			return -wheelRows
		}
		if ev.DY > 0 {
			return wheelRows
		}
		return 0
	}
	if ev.DY != 0 && in.wheel != 0 && (ev.DY < 0) != (in.wheel < 0) {
		in.wheel = 0
	}
	in.wheel += ev.DY
	rows := int(in.wheel / ch)
	in.wheel -= float32(rows) * ch
	return rows
}

func wheelEvent(r region, col, row, rows int, mods ui.Modifiers) []effect {
	kind := herdr.MouseScrollDown
	n := rows
	if rows < 0 {
		kind, n = herdr.MouseScrollUp, -rows
	}
	return send(r.target, herdr.Mouse{
		Kind: kind, Col: col, Row: row, Mods: herdrMods(mods), Lines: n,
	})
}

type paneScroll struct {
	id     string
	offset int
}

type selection struct {
	pane           string
	ax, hx         int
	ayFrom, hyFrom int
	delta, sent    int
}

type screen struct {
	inner          herdr.Rect
	dy             float32
	ax, ay, hx, hy int
}

func scrollParts(p *herdr.SurfacePane) (offset, rows int, ok bool) {
	rows = p.Inner.Height
	if rows < 1 {
		return 0, 0, false
	}
	if p.Scroll != nil {
		offset = int(p.Scroll.Offset)
	}
	return offset, rows, true
}

func paneByID(s *herdr.Surface, id string) *herdr.SurfacePane {
	if s == nil {
		return nil
	}
	for i := range s.Panes {
		if s.Panes[i].ID == id {
			return &s.Panes[i]
		}
	}
	return nil
}

func fromBottom(screenY, origin, offset, rows int) int {
	return offset + (rows - 1 - (screenY - origin))
}

func toScreen(from, origin, offset, rows int) int {
	return origin + (offset + rows - 1 - from)
}

func (s *selection) project(p *herdr.SurfacePane) (screen, bool) {
	off, rows, ok := scrollParts(p)
	if !ok {
		return screen{}, false
	}
	return screen{
		inner: p.Inner,
		ax:    s.ax,
		hx:    s.hx,
		ay:    toScreen(s.ayFrom, p.Inner.Y, off, rows),
		hy:    toScreen(s.hyFrom, p.Inner.Y, off, rows),
	}, true
}

func (in *interaction) selectionScroll(v shown) []effect {
	sel := in.sel
	if sel == nil || sel.delta == 0 || v.s == nil {
		return nil
	}
	p := paneByID(v.s, sel.pane)
	if p == nil {
		sel.delta = 0
		return nil
	}
	off, rows, ok := scrollParts(p)
	if !ok || p.Scroll == nil || p.Scroll.Max == 0 {
		sel.delta = 0
		return nil
	}
	if sel.sent >= 0 && off != sel.sent {
		return nil
	}
	next := min(max(off+sel.delta, 0), int(p.Scroll.Max))
	if next == off {
		sel.delta = 0
		sel.sent = -1
		return nil
	}
	if sel.delta > 0 {
		sel.hyFrom = next + rows - 1
	} else {
		sel.hyFrom = next
	}
	sel.sent = next
	return []effect{paneScroll{id: p.ID, offset: next}}
}

func (s screen) cols(y int) (int, int, bool) {
	ay, ax, hy, hx := s.ay, s.ax, s.hy, s.hx
	if hy < ay || hy == ay && hx < ax {
		ay, ax, hy, hx = hy, hx, ay, ax
	}
	if y < ay || y > hy || ay == hy && ax == hx {
		return 0, 0, false
	}
	a, b := s.inner.X, s.inner.X+s.inner.Width
	if y == ay {
		a = ax
	}
	if y == hy {
		b = hx + 1
	}
	return a, b, b > a
}

func (s screen) text(f *herdr.Frame) string {
	var lines []string
	for y := s.inner.Y; y < s.inner.Y+s.inner.Height; y++ {
		if a, b, ok := s.cols(y); ok {
			lines = append(lines, f.Text(herdr.Rect{X: a, Y: y, Width: b - a, Height: 1})...)
		}
	}
	return strings.Join(lines, "\n")
}

func (s *selection) word(f *herdr.Frame, inner herdr.Rect, y int) {
	space := func(x int) bool {
		c := f.Cells[y*f.W+x]
		return c.Skip || c.Symbol == " "
	}
	if space(s.ax) {
		return
	}
	for s.ax > inner.X && !space(s.ax-1) {
		s.ax--
	}
	for s.hx < inner.X+inner.Width-1 && !space(s.hx+1) {
		s.hx++
	}
}

type mouseGesture struct {
	region
	button   int
	col, row int
}

var observeInput func(herdr.Target, []herdr.InputEvent)
