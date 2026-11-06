package herdr

import "testing"

func TestVarint(t *testing.T) {
	for _, v := range []uint64{0, 250, 251, 65535, 65536, 1 << 32, 1<<64 - 1} {
		e := &enc{}
		e.uint(v)
		d := &dec{b: e.b}
		if got := d.uint(); got != v || d.err != nil || len(d.b) != 0 {
			t.Errorf("%d: got %d, err %v, left %d", v, got, d.err, len(d.b))
		}
	}
}

func cells(s string) []Cell {
	var out []Cell
	for _, r := range s {
		out = append(out, Cell{Symbol: string(r), Link: -1})
	}
	return out
}

func TestPatchAndText(t *testing.T) {
	s := &Surface{Boot: "b", Projection: 1, Revision: 1, Frame: Frame{W: 4, H: 2, Cells: cells("abcdefgh")}}
	p := &patch{boot: "b", projection: 1, base: 1, next: 2, rows: []patchRow{{x: 0, y: 1, cells: []Cell{{Symbol: "中", Link: -1}}}}}
	if !s.apply(p) || s.Revision != 2 {
		t.Fatal("patch refused")
	}
	if got := s.Frame.Text(Rect{Width: 4, Height: 2}); got[0] != "abcd" || got[1] != "中gh" {
		t.Fatalf("text %q", got)
	}
	if s.apply(p) {
		t.Fatal("a patch of another revision applied")
	}
}
