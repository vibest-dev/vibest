package app

import (
	"math"

	"vibest-desktop/internal/herdr"
)

func newChromeTestApp() *App { return NewApp("/inert/core-fixture.sock") }

type hn struct {
	id     string
	across bool
	ratio  float32
	a, b   *hn
}

func leaf(id string) *hn            { return &hn{id: id} }
func side(r float32, a, b *hn) *hn  { return &hn{across: true, ratio: r, a: a, b: b} }
func stack(r float32, a, b *hn) *hn { return &hn{ratio: r, a: a, b: b} }

func rectR(x, y, w, h int) herdr.Rect { return herdr.Rect{X: x, Y: y, Width: w, Height: h} }

func splitRect(r herdr.Rect, across bool, ratio float32) (herdr.Rect, herdr.Rect) {
	if across {
		w := int(math.Round(float64(float32(r.Width) * ratio)))
		return rectR(r.X, r.Y, w, r.Height), rectR(r.X+w, r.Y, r.Width-w, r.Height)
	}
	h := int(math.Round(float64(float32(r.Height) * ratio)))
	return rectR(r.X, r.Y, r.Width, h), rectR(r.X, r.Y+h, r.Width, r.Height-h)
}

type hconf struct {
	borders                 string
	gaps, outer, scrollbars bool
	scrolled                bool
	alt                     map[string]bool
	zoom                    string
}

var herdrDefault = hconf{borders: "auto", gaps: true, outer: true, scrollbars: true}

var chromeConfs = []hconf{
	herdrDefault,
	{borders: "off", gaps: true, outer: true, scrollbars: true},
	{borders: "off", outer: true, scrollbars: true},
	{borders: "auto", gaps: true, scrollbars: true},
}

type herdrBorders [4]bool

func herdrSurface(t *hn, cols, rows int, c hconf) (*herdr.Surface, []herdrBorders) {
	s := &herdr.Surface{Frame: herdr.Frame{W: cols, H: rows, Cells: make([]herdr.Cell, cols*rows)}}
	var ids []string
	var splits []herdr.SurfaceSplit
	var walk func(n *hn, area herdr.Rect, path []bool)
	walk = func(n *hn, area herdr.Rect, path []bool) {
		if n.a == nil {
			ids = append(ids, n.id)
			s.Panes = append(s.Panes, herdr.SurfacePane{ID: n.id, Rect: area})
			return
		}
		a, b := splitRect(area, n.across, n.ratio)
		pos := a.Y + a.Height
		if n.across {
			pos = a.X + a.Width
		}
		splits = append(splits, herdr.SurfaceSplit{Across: n.across, Pos: pos, Area: area, Path: append([]bool{}, path...)})
		walk(n.a, a, append(append([]bool{}, path...), false))
		walk(n.b, b, append(append([]bool{}, path...), true))
	}
	walk(t, rectR(0, 0, cols, rows), []bool{})
	multi := len(s.Panes) > 1
	draws := c.borders != "off"
	shows := draws && (multi || c.borders == "always")
	if c.zoom != "" {
		bs := herdrBorders{}
		if shows && c.outer {
			bs = herdrBorders{true, true, true, true}
		}
		s.Panes = []herdr.SurfacePane{{ID: c.zoom, Focused: true, Rect: rectR(0, 0, cols, rows)}}
		s.Panes[0].Inner = herdrInner(s.Panes[0].Rect, bs, c, c.zoom)
		s.Panes[0].Scrollbar = herdrScrollbar(s.Panes[0].Rect, bs, c, c.zoom)
		return s, []herdrBorders{bs}
	}
	orig := append([]herdr.SurfacePane{}, s.Panes...)
	x0, y0, x1, y1 := cols, rows, 0, 0
	for _, p := range orig {
		x0, y0 = min(x0, p.Rect.X), min(y0, p.Rect.Y)
		x1, y1 = max(x1, p.Rect.X+p.Rect.Width), max(y1, p.Rect.Y+p.Rect.Height)
	}
	var borders []herdrBorders
	for i := range s.Panes {
		r := orig[i].Rect
		right, below := false, false
		for j, o := range orig {
			if j == i {
				continue
			}
			if o.Rect.X == r.X+r.Width && r.Y < o.Rect.Y+o.Rect.Height && o.Rect.Y < r.Y+r.Height {
				right = true
			}
			if o.Rect.Y == r.Y+r.Height && r.X < o.Rect.X+o.Rect.Width && o.Rect.X < r.X+r.Width {
				below = true
			}
		}
		if multi && c.gaps && !draws {
			if right && r.Width > 1 {
				r.Width--
			}
			if below && r.Height > 1 {
				r.Height--
			}
		}
		bs := herdrBorders{}
		if shows {
			bs = herdrBorders{true, true, true, true}
			if !c.gaps {
				bs[2] = bs[2] && !right
				bs[3] = bs[3] && !below
			}
			if !c.outer {
				o := orig[i].Rect
				bs[0] = bs[0] && o.X != x0
				bs[1] = bs[1] && o.Y != y0
				bs[2] = bs[2] && o.X+o.Width != x1
				bs[3] = bs[3] && o.Y+o.Height != y1
			}
		}
		s.Panes[i].Rect = r
		s.Panes[i].Inner = herdrInner(r, bs, c, ids[i])
		s.Panes[i].Scrollbar = herdrScrollbar(r, bs, c, ids[i])
		borders = append(borders, bs)
	}
	for _, sp := range splits {
		var hit herdr.Rect
		switch {
		case draws && !c.gaps && sp.Across:
			hit = rectR(sp.Pos, sp.Area.Y, 1, sp.Area.Height)
		case draws && !c.gaps:
			hit = rectR(sp.Area.X, sp.Pos, sp.Area.Width, 1)
		case draws && sp.Across:
			start := max(sp.Pos-1, 0)
			hit = rectR(start, sp.Area.Y, sp.Pos-start+1, sp.Area.Height)
		case draws:
			start := max(sp.Pos-1, 0)
			hit = rectR(sp.Area.X, start, sp.Area.Width, sp.Pos-start+1)
		case c.gaps && sp.Pos > 0 && sp.Across:
			hit = rectR(sp.Pos-1, sp.Area.Y, 1, sp.Area.Height)
		case c.gaps && sp.Pos > 0:
			hit = rectR(sp.Area.X, sp.Pos-1, sp.Area.Width, 1)
		default:
			continue
		}
		over := false
		for _, p := range s.Panes {
			over = over || !draws && overlaps(hit, p.Rect)
		}
		if !over {
			sp.Hit = hit
			s.Splits = append(s.Splits, sp)
		}
	}
	return s, borders
}

func herdrInner(r herdr.Rect, bs herdrBorders, c hconf, id string) herdr.Rect {
	in := r
	if bs[0] {
		in.X, in.Width = in.X+1, max(in.Width-1, 0)
	}
	if bs[2] {
		in.Width = max(in.Width-1, 0)
	}
	if bs[1] {
		in.Y, in.Height = in.Y+1, max(in.Height-1, 0)
	}
	if bs[3] {
		in.Height = max(in.Height-1, 0)
	}
	if c.scrollbars && !c.alt[id] && in.Width > 4 {
		in.Width--
	}
	return in
}

func modeTree(mode string) *hn {
	switch mode {
	case "split":
		return side(0.5, leaf("a"), leaf("b"))
	case "stack":
		return stack(0.5, leaf("a"), leaf("b"))
	case "nested", "zoom":
		return side(0.5, leaf("a"), stack(0.5, leaf("b"), leaf("c")))
	}
	return leaf("a")
}

func herdrAnswer(cols, rows int, mode string) *herdr.Surface {
	return herdrAnswerAt(cols, rows, mode, herdrDefault)
}

func herdrAnswerAt(cols, rows int, mode string, c hconf) *herdr.Surface {
	if mode == "zoom" {
		c.zoom = "b"
	}
	s, _ := herdrSurface(modeTree(mode), cols, rows, c)
	focus := "a"
	if mode == "nested" || mode == "zoom" {
		focus = "b"
	}
	for i := range s.Panes {
		s.Panes[i].Focused = s.Panes[i].ID == focus
	}
	if mode == "popup" {
		s.Popup = &herdr.Popup{TerminalID: "pop", Frame: herdr.Frame{W: 4, H: 2}}
	}
	return s
}

func herdrScrollbar(r herdr.Rect, bs herdrBorders, c hconf, id string) *herdr.Rect {
	in := herdrInner(r, bs, c, id)
	if !c.scrolled || in == herdrInner(r, bs, hconf{}, id) {
		return nil
	}
	return &herdr.Rect{X: in.X + in.Width, Y: in.Y, Width: 1, Height: in.Height}
}
