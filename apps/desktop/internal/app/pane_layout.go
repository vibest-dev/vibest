package app

import (
	"math"
)

const windowCorner float32 = 24

func (m shellMetrics) cardRadius(scale float32) float32 {
	if m.radius <= 0 {
		return 0
	}
	return onPixel(m.radius, scale)
}

func headerGap(chromeH, tabH, scale float32) float32 {
	below := float32(0)
	if chromeH > tabH && tabH > 0 {
		below = (chromeH - tabH) / 2
	}
	return onPixel(outerPad-below, scale)
}

func (m shellMetrics) cardGap(scale float32) float32 {
	if m.between <= 0 {
		return gridLine(scale)
	}
	return max(onPixel(m.between, scale), gridLine(scale))
}

func (m shellMetrics) bottomPad(scale float32) float32 {
	if scale <= 0 {
		return m.bottom
	}
	return float32(math.Ceil(float64(m.bottom*scale)-0.01)) / scale
}

func (m shellMetrics) slot(open, full, scale float32) float32 {
	if full < m.gutter {
		full = m.gutter
	}
	return onPixel(m.gutter+open*(full-m.gutter), scale)
}

func (m shellMetrics) paneWidth(winW, slot float32) float32 { return winW - slot - m.outer }

func onPixel(v, scale float32) float32 {
	if scale <= 0 {
		return float32(math.Round(float64(v)))
	}
	return float32(math.Round(float64(v*scale))) / scale
}
