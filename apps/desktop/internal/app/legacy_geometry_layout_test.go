package app

import (
	"github.com/egoist/mygo/ui"
	"sort"
	"vibest-desktop/internal/herdr"
)

type inset struct{ l, t, r, b int }

func paneBorders(s *herdr.Surface) []inset {
	out := make([]inset, len(s.Panes))
	right := 0
	for _, p := range s.Panes {
		right = max(right, p.Rect.X+p.Rect.Width)
	}
	left := right
	for _, p := range s.Panes {
		left = min(left, p.Rect.X)
	}
	bordered, outer, gaps := false, false, false
	for i, p := range s.Panes {
		r, in := p.Rect, p.Inner
		b := inset{l: in.X - r.X, t: in.Y - r.Y, b: r.Y + r.Height - in.Y - in.Height}
		bordered = bordered || b.l > 0 || b.t > 0 || b.b > 0
		outer = outer || r.X == left && b.l > 0
		out[i] = b
	}
	for _, sp := range s.Splits {
		if sp.Across && sp.Hit.Width > 1 || !sp.Across && sp.Hit.Height > 1 {
			gaps = true
		}
	}
	for i, p := range s.Panes {
		atRight := p.Rect.X+p.Rect.Width == right
		if bordered && (atRight && outer || !atRight && gaps) {
			out[i].r = 1
		}
		out[i].r = min(out[i].r, max(p.Rect.X+p.Rect.Width-p.Inner.X-p.Inner.Width, 0))
	}
	return out
}

type pnode struct {
	cells  herdr.Rect
	pane   int
	across bool
	split  int
	a, b   *pnode
	ex, ey float32
}

func union(a, b herdr.Rect) herdr.Rect {
	x0, y0 := min(a.X, b.X), min(a.Y, b.Y)
	x1, y1 := max(a.X+a.Width, b.X+b.Width), max(a.Y+a.Height, b.Y+b.Height)
	return herdr.Rect{X: x0, Y: y0, Width: x1 - x0, Height: y1 - y0}
}

func paneTree(s *herdr.Surface, panes []int, ops *int) *pnode {
	if len(panes) == 0 {
		return nil
	}
	region := s.Panes[panes[0]].Rect
	for _, i := range panes[1:] {
		region = union(region, s.Panes[i].Rect)
	}
	if len(panes) == 1 {
		return &pnode{cells: region, pane: panes[0], split: -1}
	}
	part := func(across bool, c int) (a, b []int, ok bool) {
		*ops++
		for _, i := range panes {
			r := s.Panes[i].Rect
			lo, hi := r.Y, r.Y+r.Height
			if across {
				lo, hi = r.X, r.X+r.Width
			}
			switch {
			case hi <= c:
				a = append(a, i)
			case lo >= c:
				b = append(b, i)
			default:
				return nil, nil, false
			}
		}
		return a, b, len(a) > 0 && len(b) > 0
	}
	type cut struct {
		across   bool
		c, split int
	}
	var cuts []cut
	for k, sp := range s.Splits {
		if sp.Area.Contains(region.X, region.Y) && union(sp.Area, region) == sp.Area {
			cuts = append(cuts, cut{sp.Across, sp.Pos, k})
		}
	}
	for _, sp := range s.Splits {
		if a := sp.Area; a != region && a.X < region.X+region.Width && region.X < a.X+a.Width && a.Y < region.Y+region.Height && region.Y < a.Y+a.Height {
			cuts = append(cuts, cut{true, a.X + a.Width, -1}, cut{false, a.Y + a.Height, -1}, cut{true, a.X, -1}, cut{false, a.Y, -1})
		}
	}
	var at []int
	for _, i := range panes {
		at = append(at, s.Panes[i].Rect.X, s.Panes[i].Rect.Y)
	}
	sort.Ints(at)
	for _, across := range []bool{true, false} {
		for _, c := range at {
			cuts = append(cuts, cut{across, c, -1})
		}
	}
	for _, c := range cuts {
		if a, b, ok := part(c.across, c.c); ok {
			na, nb := paneTree(s, a, ops), paneTree(s, b, ops)
			if na == nil || nb == nil {
				return nil
			}
			return &pnode{cells: region, pane: -1, across: c.across, split: c.split, a: na, b: nb}
		}
	}
	return nil
}

type paneMetrics struct {
	cw, ch, scale float32
	borders       []inset
	shell         shellMetrics
}

func (n *pnode) measure(m paneMetrics) {
	side, line := sidePad(m.scale), m.shell.cardGap(m.scale)
	if n.a == nil {
		b := m.borders[n.pane]
		n.ex = 2*side - float32(b.l+b.r)*m.cw
		n.ey = headH + m.shell.bottomPad(m.scale) - float32(b.t+b.b)*m.ch
		return
	}
	n.a.measure(m)
	n.b.measure(m)
	wa, wb := float32(n.a.cells.Width)*m.cw+n.a.ex, float32(n.b.cells.Width)*m.cw+n.b.ex
	ha, hb := float32(n.a.cells.Height)*m.ch+n.a.ey, float32(n.b.cells.Height)*m.ch+n.b.ey
	w, h := float32(n.cells.Width)*m.cw, float32(n.cells.Height)*m.ch
	if n.across {
		n.ex, n.ey = wa+line+wb-w, max(ha, hb)-h
	} else {
		n.ex, n.ey = max(wa, wb)-w, ha+line+hb-h
	}
}

type paneLine struct {
	r     ui.Rect
	split int
}

func (n *pnode) place(s *herdr.Surface, r ui.Rect, m paneMetrics, v *shown) {
	side, line := sidePad(m.scale), m.shell.cardGap(m.scale)
	if n.a == nil {
		p := &s.Panes[n.pane]
		term := ui.Rect{X: r.X + side, Y: r.Y + headH, W: float32(p.Inner.Width) * m.cw, H: float32(p.Inner.Height) * m.ch}
		head := ui.Rect{X: r.X + side, Y: r.Y, W: max(min(r.W, v.w-r.X)-2*side, 0), H: headH}
		v.places = append(v.places, panePlace{pane: p, card: r, head: head, term: term})
		return
	}
	if n.across {
		wa := float32(n.a.cells.Width)*m.cw + n.a.ex
		n.a.place(s, ui.Rect{X: r.X, Y: r.Y, W: wa, H: r.H}, m, v)
		v.lines = append(v.lines, paneLine{ui.Rect{X: r.X + wa, Y: r.Y, W: line, H: r.H}, n.split})
		n.b.place(s, ui.Rect{X: r.X + wa + line, Y: r.Y, W: r.W - wa - line, H: r.H}, m, v)
		return
	}
	ha := float32(n.a.cells.Height)*m.ch + n.a.ey
	n.a.place(s, ui.Rect{X: r.X, Y: r.Y, W: r.W, H: ha}, m, v)
	v.lines = append(v.lines, paneLine{ui.Rect{X: r.X, Y: r.Y + ha, W: r.W, H: line}, n.split})
	n.b.place(s, ui.Rect{X: r.X, Y: r.Y + ha + line, W: r.W, H: r.H - ha - line}, m, v)
}

func paneRoot(s *herdr.Surface, cw, ch, scale float32, sh shellMetrics) (*pnode, paneMetrics) {
	m := paneMetrics{cw: cw, ch: ch, scale: scale, shell: sh}
	if s == nil || len(s.Panes) == 0 || cw <= 0 || ch <= 0 {
		return nil, m
	}
	all := make([]int, len(s.Panes))
	for i := range all {
		if r := s.Panes[i].Rect; r.Width <= 0 || r.Height <= 0 {
			return nil, m
		}
		all[i] = i
	}
	var ops int
	n := paneTree(s, all, &ops)
	if n == nil {
		return nil, m
	}
	m.borders = paneBorders(s)
	n.measure(m)
	return n, m
}

func paneGridIn(s *herdr.Surface, w, h, cw, ch, scale float32, sh shellMetrics) (cols, rows int) {
	n, _ := paneRoot(s, cw, ch, scale, sh)
	return gridFor(s, n, w, h, cw, ch, scale, sh)
}

func gridFor(s *herdr.Surface, n *pnode, w, h, cw, ch, scale float32, sh shellMetrics) (cols, rows int) {
	if cw <= 0 || ch <= 0 {
		return 0, 0
	}
	k := float32(1)
	if s != nil {
		k = float32(max(len(s.Panes), 1))
	}
	line := sh.cardGap(scale)
	ex, ey := k*2*sidePad(scale)+(k-1)*line, k*(headH+sh.bottomPad(scale))+(k-1)*line
	if n != nil {
		ex, ey = n.ex, n.ey
	}
	return int((w - ex + 0.01) / cw), int((h - ey + 0.01) / ch)
}

func frameLaid(s *herdr.Surface, w, h, cw, ch, scale float32, sh shellMetrics) shown {
	n, m := paneRoot(s, cw, ch, scale, sh)
	cols, rows := gridFor(s, n, w, h, cw, ch, scale, sh)
	v := shown{s: s, cw: cw, ch: ch, w: w, h: h, scale: scale, tooSmall: cols < 1 || rows < 1}
	if n == nil {
		v.tooSmall = v.tooSmall || s != nil && len(s.Panes) > 0
		return v
	}
	needW := float32(n.cells.Width)*cw + n.ex
	needH := float32(n.cells.Height)*ch + n.ey
	v.fits = needW <= w+0.01 && needH <= h+0.01
	n.place(s, ui.Rect{W: max(w, needW), H: max(h, needH)}, m, &v)
	if s.Popup != nil {
		pr := popupRect(s)
		px := onPixel((w-float32(pr.Width)*cw)/2, scale)
		py := onPixel((h-float32(pr.Height)*ch)/2, scale)
		v.ox, v.oy = px-float32(pr.X)*cw, py-float32(pr.Y)*ch
	}
	return v
}
