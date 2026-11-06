package app

import (
	"fmt"
	"math/rand"
	"testing"

	"vibest-desktop/internal/herdr"
)

var sweepFonts = []cellMetrics{
	{8, 16, 2}, {6.5, 15.5, 2}, {9.6, 19.2, 1.25}, {7, 17, 1},
	{8, 50.0 / 3, 1.5}, {22.0 / 3, 16, 1.5}, {8.8, 17.6, 1.25}, {5, 9, 1}, {13, 30, 2},
}

var sweepRatios = []float32{0.1, 0.13, 0.25, 0.5, 0.62, 0.87, 0.9}

func randomTree(r *rand.Rand, depth int, n *int) *hn {
	if depth == 0 || r.Intn(3) == 0 {
		*n++
		return leaf(fmt.Sprintf("P%d", *n))
	}
	ratio := sweepRatios[r.Intn(len(sweepRatios))]
	if r.Intn(4) == 0 {
		ratio = 0.1 + 0.8*r.Float32()
	}
	a, b := randomTree(r, depth-1, n), randomTree(r, depth-1, n)
	if r.Intn(2) == 0 {
		return side(ratio, a, b)
	}
	return stack(ratio, a, b)
}

func everyConf() []hconf {
	var out []hconf
	for _, b := range []string{"off", "auto", "always"} {
		for _, g := range []bool{true, false} {
			for _, o := range []bool{true, false} {
				for _, sb := range []bool{true, false} {
					out = append(out, hconf{borders: b, gaps: g, outer: o, scrollbars: sb})
				}
			}
		}
	}
	return out
}

func leafIDs(t *hn, out *[]string) {
	if t.a == nil {
		*out = append(*out, t.id)
		return
	}
	leafIDs(t.a, out)
	leafIDs(t.b, out)
}

func treeOps(s *herdr.Surface) (ops, bound int, tiles bool) {
	all := make([]int, len(s.Panes))
	for i := range all {
		all[i] = i
	}
	n := len(s.Panes)
	tiles = paneTree(s, all, &ops) != nil
	return ops, 2 * n * (5*len(s.Splits) + 2*n), tiles
}

func zeroCols(k int) *hn {
	col := func(i int) *hn {
		return stack(0.5, leaf(fmt.Sprintf("c%da", i)), stack(0.1, leaf(fmt.Sprintf("c%db", i)), stack(0.1, leaf(fmt.Sprintf("c%dc", i)), leaf(fmt.Sprintf("c%dd", i)))))
	}
	t := col(k - 1)
	for i := k - 2; i >= 0; i-- {
		t = side(1/float32(k-i), col(i), t)
	}
	return t
}

func zeroStack(k int) *hn {
	t := leaf(fmt.Sprintf("P%d", k))
	for i := k - 1; i >= 1; i-- {
		t = stack(0.5, leaf(fmt.Sprintf("P%d", i)), t)
	}
	return side(0.5, t, leaf("Z"))
}

func TestPanesWithoutCellsAreTooSmallAtOnce(t *testing.T) {
	type tc struct {
		name       string
		tr         *hn
		cols, rows int
	}
	var cases []tc
	for _, k := range []int{9, 14, 19, 26} {
		cases = append(cases, tc{fmt.Sprintf("stack %d", k+1), zeroStack(k), 120, 3})
	}
	for _, k := range []int{3, 5, 7} {
		cases = append(cases, tc{fmt.Sprintf("columns %d", 4*k), zeroCols(k), 200, 4})
	}
	for _, c := range cases {
		for _, conf := range everyConf() {
			s, _ := herdrSurface(c.tr, c.cols, c.rows, conf)
			id := fmt.Sprintf("%s %v %dx%d", c.name, conf, c.cols, c.rows)
			zero := false
			for _, p := range s.Panes {
				zero = zero || p.Rect.Width <= 0 || p.Rect.Height <= 0
			}
			if !zero {
				t.Fatalf("%s: herdr gave every pane a cell", id)
			}
			v := frameAt(s, 1000, 200, 8, 16, 2)
			if !v.tooSmall || len(v.places) != 0 {
				t.Fatalf("%s: tooSmall %v, %d places", id, v.tooSmall, len(v.places))
			}
			cols, rows := paneGrid(s, 4000, 4000, 8, 16, 2)
			if cols < c.cols || rows < c.rows {
				t.Fatalf("%s: asks %dx%d of 4000 DIPs, less than herdr's %dx%d", id, cols, rows, c.cols, c.rows)
			}
			if ops, bound, _ := treeOps(s); ops > bound {
				t.Fatalf("%s: %d cuts tried, bound %d", id, ops, bound)
			}
		}
	}
}

func TestRandomLayoutsSettleAndKeepEverySplit(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	confs := everyConf()
	fitting := 0
	for i := 0; i < 3000; i++ {
		n := 0
		tr := randomTree(r, 1+r.Intn(5), &n)
		var ids []string
		leafIDs(tr, &ids)
		m := sweepFonts[r.Intn(len(sweepFonts))]
		c := confs[r.Intn(len(confs))]
		c.scrolled = r.Intn(2) == 0
		c.alt = map[string]bool{}
		for _, id := range ids {
			if r.Intn(3) == 0 {
				c.alt[id] = true
			}
		}
		if len(ids) > 1 && r.Intn(5) == 0 {
			c.zoom = ids[r.Intn(len(ids))]
		}
		w := float32(300 + r.Intn(1800))
		h := float32(200 + r.Intn(1100))
		id := fmt.Sprintf("#%d n=%d %v zoom=%q %v %vx%v", i, len(ids), c, c.zoom, m, w, h)
		cols, rows := paneGrid(nil, w, h, m.cw, m.ch, m.scale)
		seen := map[[2]int]bool{}
		for round := 0; ; round++ {
			if round == 12 {
				t.Fatalf("%s: unsettled", id)
			}
			s, truth := herdrSurface(tr, cols, rows, c)
			if ops, bound, _ := treeOps(s); ops > bound {
				t.Fatalf("%s: %d cuts tried at %dx%d, bound %d", id, ops, cols, rows, bound)
			}
			nc, nr := paneGrid(s, w, h, m.cw, m.ch, m.scale)
			if nc == cols && nr == rows {
				if v := frameAt(s, w, h, m.cw, m.ch, m.scale); v.fits && !v.tooSmall {
					checkFrame(t, id, s, truth, w, h, m)
					fitting++
				}
				break
			}
			if nc < 1 || nr < 1 {
				break
			}
			seen[[2]int{cols, rows}] = true
			if seen[[2]int{nc, nr}] {
				t.Fatalf("%s: cycle at %dx%d", id, nc, nr)
			}
			cols, rows = nc, nr
		}
	}
	t.Logf("%d fitting layouts checked", fitting)
}

func TestTreeSearchIsBoundedOnSmallGrids(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	confs := everyConf()
	worst := 0.0
	for i := 0; i < 20000; i++ {
		n := 0
		tr := randomTree(r, 2+r.Intn(4), &n)
		if n > 16 {
			continue
		}
		c := confs[r.Intn(len(confs))]
		s, _ := herdrSurface(tr, 4+r.Intn(60), 2+r.Intn(12), c)
		ops, bound, _ := treeOps(s)
		if ops > bound {
			t.Fatalf("#%d %d panes: %d cuts tried, bound %d", i, n, ops, bound)
		}
		worst = max(worst, float64(ops)/float64(bound))
		zero := false
		for _, p := range s.Panes {
			zero = zero || p.Rect.Width <= 0 || p.Rect.Height <= 0
		}
		if v := frameAt(s, 1000, 300, 8, 16, 2); zero && !v.tooSmall {
			t.Fatalf("#%d %d panes: a pane without cells, not Too small", i, n)
		}
	}
	t.Logf("worst cuts tried: %.2f of the bound", worst)
}
