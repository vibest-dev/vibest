package app

import (
	"fmt"
	"math"
	"sort"
	"testing"

	"vibest-desktop/internal/herdr"

	"github.com/egoist/mygo/ui"
)

type cellMetrics struct{ cw, ch, scale float32 }

var layoutFonts = []cellMetrics{{8, 16, 2}, {6.5, 15.5, 2}, {9.6, 19.2, 1.25}, {7, 17, 1}, {12, 24, 2}}

var layoutTrees = map[string]func() *hn{
	"lone":   func() *hn { return leaf("A") },
	"side":   func() *hn { return side(0.5, leaf("A"), leaf("B")) },
	"stack":  func() *hn { return stack(0.5, leaf("A"), leaf("B")) },
	"nested": func() *hn { return side(0.5, leaf("A"), stack(0.5, leaf("B"), leaf("C"))) },
	"mixed":  func() *hn { return side(0.6, stack(0.33, leaf("A"), stack(0.5, leaf("B"), leaf("C"))), leaf("D")) },
	"grid-side-root": func() *hn {
		return side(0.5, stack(0.5, leaf("A"), leaf("B")), stack(0.5, leaf("C"), leaf("D")))
	},
	"grid-stack-root": func() *hn {
		return stack(0.5, side(0.5, leaf("A"), leaf("C")), side(0.5, leaf("B"), leaf("D")))
	},
	"extreme": func() *hn { return side(0.1, leaf("A"), stack(0.9, leaf("B"), side(0.9, leaf("C"), leaf("D")))) },
	"asym-2x2": func() *hn {
		return side(0.3, stack(0.7, leaf("A"), leaf("B")), stack(0.2, leaf("C"), leaf("D")))
	},
	"deep": func() *hn {
		t := leaf("P5")
		for i := 4; i >= 0; i-- {
			t = stack(1/float32(6-i), leaf(fmt.Sprintf("P%d", i)), t)
		}
		return side(0.5, t, stack(0.5, side(0.5, leaf("Q"), leaf("R")), leaf("S")))
	},
}

var layoutConfs = []hconf{
	{borders: "off", gaps: true, outer: true},
	{borders: "off", gaps: false, outer: true},
	{borders: "auto", gaps: true, outer: true},
	{borders: "auto", gaps: false, outer: true},
	{borders: "auto", gaps: true, outer: false},
	{borders: "auto", gaps: false, outer: false},
	{borders: "always", gaps: true, outer: true},
}

func (c hconf) String() string {
	return fmt.Sprintf("borders=%s gaps=%v outer=%v scrollbars=%v", c.borders, c.gaps, c.outer, c.scrollbars)
}

func settleTree(t *testing.T, id string, tr *hn, w, h float32, m cellMetrics, c hconf) (*herdr.Surface, []herdrBorders, int, int) {
	t.Helper()
	cols, rows := int(w/m.cw), int(h/m.ch)
	seen := map[[2]int]bool{}
	for range 8 {
		s, bs := herdrSurface(tr, cols, rows, c)
		nc, nr := paneGrid(s, w, h, m.cw, m.ch, m.scale)
		if nc == cols && nr == rows {
			return s, bs, cols, rows
		}
		if nc < 1 || nr < 1 {
			return nil, nil, nc, nr
		}
		seen[[2]int{cols, rows}] = true
		if seen[[2]int{nc, nr}] {
			t.Fatalf("%s: the request went back to %dx%d", id, nc, nr)
		}
		cols, rows = nc, nr
	}
	t.Fatalf("%s: the request did not settle", id)
	return nil, nil, 0, 0
}

func onDevicePixel(v, scale float32) bool {
	p := float64(v * scale)
	return math.Abs(p-math.Round(p)) < 0.01
}

func checkFrame(t *testing.T, id string, s *herdr.Surface, truth []herdrBorders, w, h float32, m cellMetrics) shown {
	t.Helper()
	v := frameAt(s, w, h, m.cw, m.ch, m.scale)
	if c, r := paneGrid(s, w, h, m.cw, m.ch, m.scale); !v.fits || v.tooSmall || c != s.Frame.W || r != s.Frame.H {
		t.Fatalf("%s: fits %v tooSmall %v asks %dx%d for %dx%d", id, v.fits, v.tooSmall, c, r, s.Frame.W, s.Frame.H)
	}
	if len(v.places) != len(s.Panes) {
		t.Fatalf("%s: %d places for %d panes", id, len(v.places), len(s.Panes))
	}
	sidePx := sidePad(m.scale)
	in := func(a, b ui.Rect) bool {
		return a.X >= b.X-0.01 && a.Y >= b.Y-0.01 && a.X+a.W <= b.X+b.W+0.01 && a.Y+a.H <= b.Y+b.H+0.01
	}
	cross := func(a, b ui.Rect) bool {
		return a.X < b.X+b.W-0.01 && b.X < a.X+a.W-0.01 && a.Y < b.Y+b.H-0.01 && b.Y < a.Y+a.H-0.01
	}
	whole := true
	for _, p := range s.Panes {
		whole = whole && p.Inner.Width > 0 && p.Inner.Height > 0
	}
	got := paneBorders(s)
	area := float32(0)
	for i, pl := range v.places {
		p := pl.pane
		if whole {
			b := truth[i]
			want := inset{l: b2i(b[0]), t: b2i(b[1]), r: b2i(b[2]), b: b2i(b[3])}
			if got[i] != want {
				t.Errorf("%s %s: borders read %+v, herdr drew %+v", id, p.ID, got[i], want)
			}
		}
		if !nearDip(pl.term.W, float32(p.Inner.Width)*m.cw) || !nearDip(pl.term.H, float32(p.Inner.Height)*m.ch) {
			t.Errorf("%s %s: term %v for inner %v", id, p.ID, pl.term, p.Inner)
		}
		if !in(pl.term, pl.card) || !in(pl.card, ui.Rect{W: w, H: h}) {
			t.Errorf("%s %s: term %v card %v outside", id, p.ID, pl.term, pl.card)
		}
		if pl.head.H != headH || !nearDip(pl.head.Y, pl.card.Y) || !nearDip(pl.term.Y, pl.card.Y+headH) {
			t.Errorf("%s %s: head %v term %v card %v", id, p.ID, pl.head, pl.term, pl.card)
		}
		if !nearDip(pl.term.X-pl.card.X, sidePx) || !nearDip(pl.card.X+pl.card.W-(pl.head.X+pl.head.W), sidePx) {
			t.Errorf("%s %s: side pads %v %v", id, p.ID, pl.term.X-pl.card.X, pl.card.X+pl.card.W-(pl.head.X+pl.head.W))
		}
		gutter := float32(p.Rect.Width-got[i].l-got[i].r-p.Inner.Width) * m.cw
		if pl.card.X+pl.card.W-(pl.term.X+pl.term.W+gutter) < sidePx-0.01 {
			t.Errorf("%s %s: %v right of the scrollbar column", id, p.ID, pl.card.X+pl.card.W-(pl.term.X+pl.term.W+gutter))
		}
		if sb := p.Scrollbar; sb != nil {
			x := pl.term.X + float32(sb.X-p.Inner.X)*m.cw
			if !nearDip(x, pl.term.X+pl.term.W) || x+float32(sb.Width)*m.cw > pl.card.X+pl.card.W-sidePx+0.01 {
				t.Errorf("%s %s: scrollbar %v at %v, term %v card %v", id, p.ID, sb, x, pl.term, pl.card)
			}
		}
		if pl.card.Y+pl.card.H-(pl.term.Y+pl.term.H) < bottomPad(m.scale)-0.01 {
			t.Errorf("%s %s: bottom %v", id, p.ID, pl.card.Y+pl.card.H-(pl.term.Y+pl.term.H))
		}
		edges := []float32{pl.term.X, pl.term.Y, pl.card.X, pl.card.Y}
		if r := pl.card.X + pl.card.W; !nearDip(r, w) {
			edges = append(edges, r)
		}
		if b := pl.card.Y + pl.card.H; !nearDip(b, h) {
			edges = append(edges, b)
		}
		for _, x := range edges {
			if !onDevicePixel(x, m.scale) {
				t.Errorf("%s %s: %v off the pixel grid at %v", id, p.ID, x, m.scale)
			}
		}
		if p.Inner.Width >= minTermCols && p.Inner.Height >= minTermRows && !v.showsPane(p.ID) {
			t.Errorf("%s %s: not shown, term %v", id, p.ID, pl.term)
		}
		for _, o := range v.places[i+1:] {
			if cross(pl.card, o.card) {
				t.Errorf("%s: cards %s %v and %s %v overlap", id, p.ID, pl.card, o.pane.ID, o.card)
			}
		}
		for _, l := range v.lines {
			if cross(pl.card, l.r) {
				t.Errorf("%s: line %v crosses %s", id, l.r, p.ID)
			}
		}
		area += pl.card.W * pl.card.H
	}
	for _, l := range v.lines {
		area += l.r.W * l.r.H
	}
	if !nearDip(area/(w*h), 1) {
		t.Errorf("%s: cards and lines cover %.4f of the element", id, area/(w*h))
	}
	n, _ := paneRoot(s, m.cw, m.ch, m.scale, metricsFor(1))
	if rw, rh := w-(float32(n.cells.Width)*m.cw+n.ex), h-(float32(n.cells.Height)*m.ch+n.ey); rw >= m.cw-0.01 || rh >= m.ch-0.01 {
		t.Errorf("%s: %v x %v left over, cell %v x %v", id, rw, rh, m.cw, m.ch)
	}
	for k := range s.Splits {
		var ls []paneLine
		for _, l := range v.lines {
			if l.split == k {
				ls = append(ls, l)
			}
		}
		if len(ls) != 1 {
			t.Fatalf("%s: split %d has lines %v", id, k, ls)
		}
		r := ls[0].r
		if got := v.splitAt(r.X+r.W/2, r.Y+r.H/2); got != &s.Splits[k] {
			t.Errorf("%s: the line of split %d grabs %v", id, k, got)
		}
	}
	return v
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func sortedKeys[V any](m map[string]V) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestEveryPaneGetsItsHeader(t *testing.T) {
	n := 0
	for _, name := range sortedKeys(layoutTrees) {
		for _, m := range layoutFonts {
			for _, c := range layoutConfs {
				for _, sb := range []bool{true, false} {
					c.scrollbars, c.scrolled = sb, sb
					for _, wh := range [][2]float32{{1032, 764}, {1517, 931}, {640, 480}} {
						id := fmt.Sprintf("%s %v %v %v", name, m, c, wh)
						s, truth, cols, rows := settleTree(t, id, layoutTrees[name](), wh[0], wh[1], m, c)
						if s == nil {
							t.Fatalf("%s: too small at %dx%d", id, cols, rows)
						}
						checkFrame(t, id, s, truth, wh[0], wh[1], m)
						n++
					}
				}
			}
		}
	}
	t.Logf("%d layouts", n)
}

func TestTinyGridsSettle(t *testing.T) {
	for _, name := range sortedKeys(layoutTrees) {
		for _, c := range layoutConfs {
			c.scrollbars = true
			m := layoutFonts[0]
			for w := float32(40); w <= 260; w += 9 {
				for h := float32(40); h <= 300; h += 11 {
					id := fmt.Sprintf("%s %v %vx%v", name, c, w, h)
					if s, _, _, _ := settleTree(t, id, layoutTrees[name](), w, h, m, c); s != nil {
						if v := frameAt(s, w, h, m.cw, m.ch, m.scale); !v.fits && !v.tooSmall {
							t.Fatalf("%s: settled but does not fit", id)
						}
					}
				}
			}
		}
	}
}

func TestAlternateScreenKeepsTheLayout(t *testing.T) {
	m := layoutFonts[1]
	for _, name := range []string{"lone", "side", "nested", "mixed", "asym-2x2"} {
		for _, c := range layoutConfs {
			c.scrollbars = true
			id := fmt.Sprintf("%s %v", name, c)
			tr := layoutTrees[name]()
			s, _, cols, rows := settleTree(t, id, tr, 1032, 764, m, c)
			v := frameAt(s, 1032, 764, m.cw, m.ch, m.scale)
			for _, p := range s.Panes {
				alt := c
				alt.alt = map[string]bool{p.ID: true}
				sa, _ := herdrSurface(tr, cols, rows, alt)
				if ac, ar := paneGrid(sa, 1032, 764, m.cw, m.ch, m.scale); ac != cols || ar != rows {
					t.Fatalf("%s: %s on the alternate screen asks for %dx%d, not %dx%d", id, p.ID, ac, ar, cols, rows)
				}
				va := frameAt(sa, 1032, 764, m.cw, m.ch, m.scale)
				for i := range v.places {
					if v.places[i].card != va.places[i].card || v.places[i].head != va.places[i].head || v.places[i].term.X != va.places[i].term.X {
						t.Fatalf("%s: %s on the alternate screen moved %s: %+v to %+v", id, p.ID, v.places[i].pane.ID, v.places[i], va.places[i])
					}
				}
			}
		}
	}
}

func TestDragMapsBack(t *testing.T) {
	m := layoutFonts[0]
	w, h := float32(1032), float32(764)
	for _, name := range []string{"side", "stack", "nested", "mixed", "deep", "asym-2x2"} {
		for _, c := range []hconf{layoutConfs[0], layoutConfs[2], layoutConfs[5]} {
			c.scrollbars = true
			id := fmt.Sprintf("%s %v", name, c)
			tr := layoutTrees[name]()
			s, _, cols, rows := settleTree(t, id, tr, w, h, m, c)
			v := frameAt(s, w, h, m.cw, m.ch, m.scale)
			v.tab = "t"
			for k, sp := range s.Splits {
				var l ui.Rect
				for _, pl := range v.lines {
					if pl.split == k {
						l = pl.r
					}
				}
				for _, d := range []int{-3, -1, 2, 5} {
					cell := m.ch
					if sp.Across {
						cell = m.cw
					}
					x, y := l.X+l.W/2, l.Y+l.H/2
					var in interaction
					in.handle(ui.InputEvent{Kind: ui.InputPointerDown, X: x, Y: y}, v)
					if sp.Across {
						x += float32(d)*cell + 0.3*cell
					} else {
						y += float32(d)*cell + 0.3*cell
					}
					_, fx := in.handle(ui.InputEvent{Kind: ui.InputPointerMove, X: x, Y: y}, v)
					if len(fx) != 1 {
						t.Fatalf("%s split %d: %v", id, k, fx)
					}
					r := fx[0].(ratio).value
					if r <= 0.1 || r >= 0.9 {
						continue
					}
					moved := cloneTree(tr)
					moved.setRatio(sp.Path, r)
					s2, _ := herdrSurface(moved, cols, rows, c)
					if s2.Splits[k].Pos != sp.Pos+d {
						t.Fatalf("%s split %d: %d cells moved the cut %d to %d", id, k, d, sp.Pos, s2.Splits[k].Pos)
					}
					v2 := frameAt(s2, w, h, m.cw, m.ch, m.scale)
					var l2 ui.Rect
					for _, pl := range v2.lines {
						if pl.split == k {
							l2 = pl.r
						}
					}
					if from, to := l.X, l2.X; sp.Across && !nearDip(to-from, float32(d)*m.cw) || !sp.Across && !nearDip(l2.Y-l.Y, float32(d)*m.ch) {
						t.Errorf("%s split %d: %d cells moved the line %v to %v", id, k, d, l, l2)
					}
				}
			}
		}
	}
}

func cloneTree(n *hn) *hn {
	if n == nil {
		return nil
	}
	c := *n
	c.a, c.b = cloneTree(n.a), cloneTree(n.b)
	return &c
}

func (n *hn) setRatio(path []bool, r float32) {
	for _, second := range path {
		if second {
			n = n.b
		} else {
			n = n.a
		}
	}
	n.ratio = r
}

func TestNoHandleWithoutBordersOrGaps(t *testing.T) {
	m := layoutFonts[0]
	c := hconf{borders: "off", outer: true, scrollbars: true}
	s, truth, _, _ := settleTree(t, "nested", layoutTrees["nested"](), 1032, 764, m, c)
	if len(s.Splits) != 0 {
		t.Fatalf("herdr sent splits %v", s.Splits)
	}
	v := checkFrame(t, "nested", s, truth, 1032, 764, m)
	if len(v.lines) != 2 {
		t.Fatalf("lines %v", v.lines)
	}
	for _, l := range v.lines {
		if l.split != -1 || v.splitAt(l.r.X+l.r.W/2, l.r.Y+l.r.H/2) != nil {
			t.Fatalf("line %+v is a grab", l)
		}
	}
}

func TestShallowColumnSlack(t *testing.T) {
	m := layoutFonts[0]
	s, truth, _, _ := settleTree(t, "mixed", layoutTrees["mixed"](), 1032, 764, m, herdrDefault)
	v := checkFrame(t, "mixed", s, truth, 1032, 764, m)
	a, _ := v.place("A")
	d, _ := v.place("D")
	if a.head.Y != 0 || d.head.Y != 0 {
		t.Fatalf("top headers %v %v", a.head, d.head)
	}
	slack := d.card.Y + d.card.H - (d.term.Y + d.term.H)
	t.Logf("D: %.1f DIPs below its last row (%.2f rows)", slack, slack/m.ch)
	if slack < bottomPad(m.scale) {
		t.Fatalf("D slack %v", slack)
	}
}
