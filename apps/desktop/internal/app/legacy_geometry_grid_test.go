package app

import (
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
	"strings"
	"vibest-desktop/internal/herdr"
)

type grid struct {
	fontKey               fontKey
	font                  terminal.Font
	cw, ch, pw, ph, scale float32
	cols, rows            int
	tooSmall              bool
	shell                 shellMetrics
}
type fontKey struct {
	family, features        string
	size, scale, lineHeight float32
	weight                  int
	thicken                 bool
}

func (g *grid) layout(look terminal.Options, size float32, r ui.Rect, scale float32, s *herdr.Surface) {
	family := look.Font.Family
	if family == "" {
		family = "monospace"
	}
	features := strings.Join(look.Font.Features, ",")
	weight := look.Font.Weight
	if weight <= 0 {
		weight = 400
	}
	lineHeight := look.Font.LineHeight
	if lineHeight <= 0 {
		lineHeight = 1
	}
	key := fontKey{family, features, size, scale, lineHeight, weight, look.Font.Thicken}
	if key != g.fontKey {
		g.fontKey, g.scale = key, scale
		g.font = look.Font
		g.font.Size = size * scale
		w, h := terminal.CellSize(g.font, 1)
		g.pw, g.ph = float32(w), float32(h)
		g.cw, g.ch = g.pw/scale, g.ph/scale
	}
	cols, rows := paneGridIn(s, r.W, r.H, g.cw, g.ch, g.scale, g.shell)
	g.tooSmall = cols < 1 || rows < 1
	if !g.tooSmall {
		g.cols, g.rows = cols, rows
	}
}

func overlaps(a, b herdr.Rect) bool {
	return a.X < b.X+b.Width && b.X < a.X+a.Width && a.Y < b.Y+b.Height && b.Y < a.Y+a.Height
}

func popupRect(s *herdr.Surface) herdr.Rect {
	f := s.Popup.Frame
	return herdr.Rect{X: (s.Frame.W - f.W) / 2, Y: (s.Frame.H - f.H) / 2, Width: f.W, Height: f.H}
}
