package herdr

import (
	"encoding/binary"
	"errors"
	"math"
	"unicode/utf8"

	"golang.org/x/text/width"
)

type enc struct{ b []byte }

func (e *enc) u8(v uint8) { e.b = append(e.b, v) }
func (e *enc) boolean(v bool) {
	if v {
		e.u8(1)
	} else {
		e.u8(0)
	}
}

func (e *enc) uint(v uint64) {
	switch {
	case v < 251:
		e.b = append(e.b, byte(v))
	case v <= math.MaxUint16:
		e.b = append(e.b, 251)
		e.b = binary.LittleEndian.AppendUint16(e.b, uint16(v))
	case v <= math.MaxUint32:
		e.b = append(e.b, 252)
		e.b = binary.LittleEndian.AppendUint32(e.b, uint32(v))
	default:
		e.b = append(e.b, 253)
		e.b = binary.LittleEndian.AppendUint64(e.b, v)
	}
}

func (e *enc) str(s string) { e.uint(uint64(len(s))); e.b = append(e.b, s...) }
func (e *enc) none()        { e.u8(0) }

func (e *enc) char(r rune) { e.b = utf8.AppendRune(e.b, r) }

var errShort = errors.New("herdr: short message")

type dec struct {
	b   []byte
	err error
}

func (d *dec) take(n int) []byte {
	if d.err != nil || n < 0 || n > len(d.b) {
		d.err = errShort
		return nil
	}
	v := d.b[:n]
	d.b = d.b[n:]
	return v
}

func (d *dec) u8() uint8 {
	if v := d.take(1); v != nil {
		return v[0]
	}
	return 0
}

func (d *dec) boolean() bool { return d.u8() != 0 }

func (d *dec) uint() uint64 {
	switch t := d.u8(); t {
	case 251:
		if v := d.take(2); v != nil {
			return uint64(binary.LittleEndian.Uint16(v))
		}
	case 252:
		if v := d.take(4); v != nil {
			return uint64(binary.LittleEndian.Uint32(v))
		}
	case 253:
		if v := d.take(8); v != nil {
			return binary.LittleEndian.Uint64(v)
		}
	default:
		return uint64(t)
	}
	return 0
}

func (d *dec) int() int64 {
	v := d.uint()
	return int64(v>>1) ^ -int64(v&1)
}

func (d *dec) u16() int { return int(d.uint()) }

func (d *dec) length() int {
	n := d.uint()
	if n > uint64(len(d.b)) {
		d.err = errShort
		return 0
	}
	return int(n)
}

func (d *dec) bytes() []byte { return d.take(d.length()) }
func (d *dec) str() string   { return string(d.bytes()) }

func (d *dec) some() bool { return d.u8() == 1 }

func (d *dec) optStr() string {
	if d.some() {
		return d.str()
	}
	return ""
}

type Cell struct {
	Symbol string
	FG, BG uint32
	Mod    uint16
	Skip   bool
	Link   int32
}

const (
	ModBold      = 1
	ModDim       = 2
	ModItalic    = 4
	ModUnderline = 8
	ModReversed  = 64
	ModHidden    = 128
	ModStrike    = 256
)

type Cursor struct {
	X, Y    int
	Visible bool
	Shape   uint8
}

type Frame struct {
	Cells  []Cell
	W, H   int
	Cursor *Cursor
	Links  []string
}

type Rect struct{ X, Y, Width, Height int }

func (r Rect) Contains(x, y int) bool {
	return x >= r.X && y >= r.Y && x < r.X+r.Width && y < r.Y+r.Height
}

type SurfacePane struct {
	ID             string
	Rect, Inner    Rect
	Scrollbar      *Rect
	Scroll         *Scroll
	Focused        bool
	MouseReporting bool
}

type Scroll struct{ Offset, Max, Rows uint64 }

type SurfaceSplit struct {
	Across    bool
	Pos       int
	Area, Hit Rect
	Path      []bool
}

type Popup struct {
	TerminalID, Title string
	Frame             Frame
	MouseReporting    bool
}

type Surface struct {
	Boot       string
	Projection uint64
	Revision   uint64
	Frame      Frame
	Panes      []SurfacePane
	Splits     []SurfaceSplit
	Popup      *Popup
}

func (d *dec) cell() Cell {
	c := Cell{Symbol: d.str(), FG: uint32(d.uint()), BG: uint32(d.uint()), Mod: uint16(d.uint()), Skip: d.boolean(), Link: -1}
	if d.some() {
		c.Link = int32(d.uint())
	}
	return c
}

func (d *dec) cells() []Cell {
	n := d.length()
	out := make([]Cell, 0, n)
	for range n {
		out = append(out, d.cell())
	}
	return out
}

func (d *dec) cursor() *Cursor {
	if !d.some() {
		return nil
	}
	return &Cursor{X: d.u16(), Y: d.u16(), Visible: d.boolean(), Shape: d.u8()}
}

func (d *dec) frame() Frame {
	f := Frame{Cells: d.cells(), W: d.u16(), H: d.u16(), Cursor: d.cursor()}
	for range d.length() {
		f.Links = append(f.Links, d.str())
	}
	d.bytes()
	return f
}

func (d *dec) rect() Rect { return Rect{d.u16(), d.u16(), d.u16(), d.u16()} }

func (d *dec) panes() []SurfacePane {
	var out []SurfacePane
	for range d.length() {
		p := SurfacePane{ID: d.str()}
		d.uint()
		p.Rect, p.Inner = d.rect(), d.rect()
		if d.some() {
			r := d.rect()
			p.Scrollbar = &r
		}
		if d.some() {
			p.Scroll = &Scroll{d.uint(), d.uint(), d.uint()}
		}
		p.Focused, p.MouseReporting = d.boolean(), d.boolean()
		d.boolean()
		d.boolean()
		d.uint()
		d.uint()
		out = append(out, p)
	}
	return out
}

func (d *dec) popupSize() {
	if d.some() {
		d.uint()
		d.uint()
	}
}

func (d *dec) surface() *Surface {
	s := &Surface{Boot: d.str(), Projection: d.uint(), Revision: d.uint(), Frame: d.frame(), Panes: d.panes()}
	for range d.length() {
		sp := SurfaceSplit{Across: d.uint() == 0, Pos: d.u16(), Area: d.rect(), Hit: d.rect(), Path: []bool{}}
		for range d.length() {
			sp.Path = append(sp.Path, d.boolean())
		}
		s.Splits = append(s.Splits, sp)
	}
	if d.some() {
		p := &Popup{TerminalID: d.str(), Title: d.str()}
		d.popupSize()
		d.popupSize()
		p.Frame = d.frame()
		p.MouseReporting = d.boolean()
		d.boolean()
		d.uint()
		d.uint()
		s.Popup = p
	}
	d.graphics()
	return s
}

func (d *dec) graphics() {
	for range d.length() {
		d.assetKey()
		d.bytes()
	}
	for range d.length() {
		d.assetKey()
		for range 3 {
			d.uint()
		}
		for range 8 {
			d.uint()
		}
		d.int()
		d.uint()
	}
	for range d.length() {
		d.assetKey()
	}
}

func (d *dec) assetKey() {
	switch d.uint() {
	case 0:
		d.uint()
		d.str()
		d.uint()
	default:
		d.str()
		d.str()
	}
	d.uint()
	d.uint()
	d.uint()
	d.uint()
	d.uint()
}

type patch struct {
	boot                   string
	projection, base, next uint64
	rows                   []patchRow
	panes                  []SurfacePane
	cursor                 *Cursor
}

type patchRow struct {
	x, y  int
	cells []Cell
}

func (d *dec) patch() *patch {
	p := &patch{boot: d.str(), projection: d.uint(), base: d.uint(), next: d.uint()}
	p.rows = d.patchRows()
	p.panes = d.panes()
	p.cursor = d.cursor()
	return p
}

func (d *dec) patchRows() []patchRow {
	var rows []patchRow
	for range d.length() {
		rows = append(rows, patchRow{d.u16(), d.u16(), d.cells()})
	}
	return rows
}

func rowsFit(rows []patchRow, w, h int) bool {
	for _, r := range rows {
		if r.y >= h || r.x+len(r.cells) > w {
			return false
		}
	}
	return true
}

func applyRows(cells []Cell, w int, rows []patchRow) {
	for _, r := range rows {
		copy(cells[r.y*w+r.x:], r.cells)
	}
}

func (s *Surface) fits(p *patch) bool {
	return p.boot == s.Boot && p.projection == s.Projection && p.base == s.Revision && p.next == s.Revision+1 &&
		s.Popup == nil && rowsFit(p.rows, s.Frame.W, s.Frame.H)
}

func (s *Surface) apply(p *patch) bool {
	if !s.fits(p) {
		return false
	}
	applyRows(s.Frame.Cells, s.Frame.W, p.rows)
	for _, np := range p.panes {
		for i := range s.Panes {
			if s.Panes[i].ID == np.ID {
				s.Panes[i] = np
			}
		}
	}
	s.Frame.Cursor = p.cursor
	s.Revision = p.next
	return true
}

const (
	scrollKind = "endpoint.surface-scroll.v1"
	deltaKind  = "endpoint.surface-delta.v1"
)

var (
	errScroll = errors.New("herdr: surface scroll does not match its base")
	errDelta  = errors.New("herdr: surface delta does not match its base")
)

func (s *Surface) scroll(b []byte) (*Surface, error) {
	if len(b) == 0 || len(b) < 1+int(b[0])*10+4 {
		return nil, errScroll
	}
	n, w, h := int(b[0]), s.Frame.W, s.Frame.H
	regions := make([]Rect, n)
	shifts := make([]int, n)
	for i := range n {
		c := b[1+i*10:]
		u := func(at int) int { return int(binary.LittleEndian.Uint16(c[at:])) }
		regions[i], shifts[i] = Rect{u(0), u(2), u(4), u(6)}, int(int16(u(8)))
		if r := regions[i]; r.X+r.Width > w || r.Y+r.Height > h {
			return nil, errScroll
		}
	}
	d := &dec{b: b[1+n*10+4:]}
	if d.uint() != msgPatch {
		return nil, errScroll
	}
	p := d.patch()
	if d.err != nil || len(d.b) != 0 || !s.fits(p) {
		return nil, errScroll
	}
	for i, r := range regions {
		swap := func(y0, y1 int) {
			row0 := s.Frame.Cells[(r.Y+y0)*w+r.X:][:r.Width]
			row1 := s.Frame.Cells[(r.Y+y1)*w+r.X:][:r.Width]
			for x := range row0 {
				row0[x], row1[x] = row1[x], row0[x]
			}
		}
		if k := shifts[i]; k > 0 {
			for y := 0; y < r.Height-k; y++ {
				swap(y, y+k)
			}
		} else {
			for y := r.Height - 1; y >= -k; y-- {
				swap(y, y+k)
			}
		}
	}
	s.apply(p)
	return s, nil
}

func (s *Surface) delta(b []byte) (*Surface, error) {
	d := &dec{b: b}
	baseProjection, baseRevision := d.uint(), d.uint()
	next := d.surface()
	rows := d.patchRows()
	var popRows []patchRow
	var popCells []Cell
	popUpdate := d.some()
	if popUpdate {
		if d.uint() == 0 {
			popRows = d.patchRows()
		} else {
			popCells = d.cells()
		}
	}
	f, p := &next.Frame, next.Popup
	if d.err != nil || len(d.b) != 0 || next.Boot != s.Boot || baseProjection != s.Projection || baseRevision != s.Revision ||
		next.Revision != s.Revision+1 || f.W != s.Frame.W || f.H != s.Frame.H || !rowsFit(rows, f.W, f.H) || (p != nil) != popUpdate {
		return nil, errDelta
	}
	if p != nil {
		size := p.Frame.W * p.Frame.H
		if popCells == nil {
			prev := s.Popup
			if prev == nil || prev.TerminalID != p.TerminalID || prev.Frame.W != p.Frame.W || len(prev.Frame.Cells) != size ||
				!rowsFit(popRows, p.Frame.W, p.Frame.H) {
				return nil, errDelta
			}
			popCells = prev.Frame.Cells
			applyRows(popCells, p.Frame.W, popRows)
		} else if len(popCells) != size {
			return nil, errDelta
		}
		p.Frame.Cells = popCells
	}
	f.Cells = s.Frame.Cells
	applyRows(f.Cells, f.W, rows)
	return next, nil
}

func Wide(s string) bool {
	r, _ := utf8.DecodeRuneInString(s)
	if r < 0x1100 {
		return false
	}
	k := width.LookupRune(r).Kind()
	return k == width.EastAsianWide || k == width.EastAsianFullwidth
}

func (f *Frame) Text(r Rect) []string {
	var rows []string
	for y := r.Y; y < r.Y+r.Height && y < f.H; y++ {
		var line []byte
		for x := r.X; x < r.X+r.Width && x < f.W; x++ {
			c := f.Cells[y*f.W+x]
			if c.Symbol == "" {
				continue
			}
			if Wide(c.Symbol) {
				x++
			}
			if c.Skip {
				line = append(line, ' ')
			} else {
				line = append(line, c.Symbol...)
			}
		}
		for len(line) > 0 && line[len(line)-1] == ' ' {
			line = line[:len(line)-1]
		}
		rows = append(rows, string(line))
	}
	return rows
}
