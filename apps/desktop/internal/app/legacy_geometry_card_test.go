package app

import (
	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/herdr"
)

type panePlace struct {
	pane       *herdr.SurfacePane
	card, head ui.Rect
	term       ui.Rect
}

const (
	minTermCols = 4
	minTermRows = 2
)

func paneShowsTerminal(p herdr.SurfacePane, term ui.Rect, elemW, elemH float32, pending bool) bool {
	in := p.Inner
	if in.Width < minTermCols || in.Height < minTermRows {
		return false
	}
	return pending || term.X > -0.5 && term.Y > -0.5 && term.X+term.W < elemW+0.5 && term.Y+term.H < elemH+0.5
}

func inElement(r ui.Rect, w, h float32) bool {
	return r.X > -0.5 && r.Y > -0.5 && r.X+r.W < w+0.5 && r.Y+r.H < h+0.5
}

func (v shown) place(id string) (panePlace, bool) {
	for _, pl := range v.places {
		if pl.pane.ID == id {
			return pl, true
		}
	}
	return panePlace{}, false
}

func (v shown) showsPane(id string) bool {
	pl, ok := v.place(id)
	return ok && !v.tooSmall && paneShowsTerminal(*pl.pane, pl.term, v.w, v.h, v.pending)
}

func (v shown) headerAt(x, y float32) (panePlace, bool) {
	if v.s == nil || v.s.Popup != nil {
		return panePlace{}, false
	}
	for _, pl := range v.places {
		if pl.head.Contains(x, y) {
			return pl, true
		}
	}
	return panePlace{}, false
}

func (v shown) splitAt(px, py float32) *herdr.SurfaceSplit {
	if v.s == nil || v.s.Popup != nil || v.tooSmall {
		return nil
	}
	for _, pl := range v.places {
		if pl.head.Contains(px, py) || pl.term.Contains(px, py) {
			return nil
		}
	}
	best, near := -1, sidePad(v.scale)
	for _, l := range v.lines {
		dx := max(l.r.X-px, px-(l.r.X+l.r.W), 0)
		dy := max(l.r.Y-py, py-(l.r.Y+l.r.H), 0)
		if d := max(dx, dy); l.split >= 0 && d <= near && (best < 0 || d < near) {
			best, near = l.split, d
		}
	}
	if best < 0 {
		return nil
	}
	return &v.s.Splits[best]
}

type headButton struct {
	kind string
	r    ui.Rect
}

func headButtons(pl panePlace) []headButton {
	h, bw := pl.head, headButtonSize
	if h.W < bw || h.H < headPad+bw {
		return nil
	}
	y := h.Y + headPad
	gap := headGap
	closeR := ui.Rect{X: h.X + h.W - bw, Y: y, W: bw, H: bw}
	out := []headButton{{"close-pane", closeR}}
	if h.W < bw*2+gap+28 {
		return out
	}
	zoomR := ui.Rect{X: closeR.X - gap - bw, Y: y, W: bw, H: bw}
	out = []headButton{{"zoom", zoomR}, {"close-pane", closeR}}
	if h.W < bw*4+gap*3+28 {
		return out
	}
	down := ui.Rect{X: zoomR.X - gap - bw, Y: y, W: bw, H: bw}
	right := ui.Rect{X: down.X - gap - bw, Y: y, W: bw, H: bw}
	return []headButton{{"split-right", right}, {"split-down", down}, {"zoom", zoomR}, {"close-pane", closeR}}
}
