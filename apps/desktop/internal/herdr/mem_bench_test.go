package herdr

import "testing"

func benchSurface(w, h int) []byte {
	e := &enc{}
	e.str("boot")
	e.uint(1)
	e.uint(1)
	e.uint(uint64(w * h))
	for i := range w * h {
		sym := string(rune('a' + i%26))
		switch i % 40 {
		case 0:
			sym = "│"
		case 1:
			sym = "漢"
		}
		e.str(sym)
		e.uint(uint64(i % 7))
		e.uint(0)
		e.uint(0)
		e.boolean(false)
		e.none()
	}
	e.uint(uint64(w))
	e.uint(uint64(h))
	e.none()
	e.uint(0)
	e.uint(0)
	e.uint(0)
	e.uint(0)
	e.none()
	e.uint(0)
	e.uint(0)
	e.uint(0)
	return e.b
}

func benchPatch(w int) []byte {
	e := &enc{}
	e.str("boot")
	e.uint(1)
	e.uint(1)
	e.uint(2)
	e.uint(1)
	e.uint(0)
	e.uint(5)
	e.uint(uint64(w))
	for i := range w {
		e.str(string(rune('a' + i%26)))
		e.uint(0)
		e.uint(0)
		e.uint(0)
		e.boolean(false)
		e.none()
	}
	e.uint(0)
	e.none()
	return e.b
}

func BenchmarkDecodeSurface240x60(b *testing.B) {
	msg := benchSurface(240, 60)
	b.SetBytes(int64(len(msg)))
	b.ReportAllocs()
	for b.Loop() {
		d := &dec{b: msg}
		if s := d.surface(); d.err != nil || len(s.Frame.Cells) != 240*60 {
			b.Fatal(d.err)
		}
	}
}

func BenchmarkPatchRowAndPublish240x60(b *testing.B) {
	d := &dec{b: benchSurface(240, 60)}
	s := d.surface()
	p := benchPatch(240)
	b.ReportAllocs()
	for b.Loop() {
		d := &dec{b: p}
		pt := d.patch()
		pt.base, pt.next = s.Revision, s.Revision+1
		if !s.apply(pt) {
			b.Fatal("patch refused")
		}
		_ = s.clone()
	}
}

func BenchmarkClone240x60(b *testing.B) {
	d := &dec{b: benchSurface(240, 60)}
	s := d.surface()
	b.ReportAllocs()
	for b.Loop() {
		_ = s.clone()
	}
}

func BenchmarkFrameText240x60(b *testing.B) {
	d := &dec{b: benchSurface(240, 60)}
	s := d.surface()
	b.ReportAllocs()
	for b.Loop() {
		_ = s.Frame.Text(Rect{Width: 240, Height: 60})
	}
}
