package app

import "vibest-desktop/internal/herdr"

func cardRadius(scale float32) float32 { return metricsFor(1).cardRadius(scale) }

func cardGap(scale float32) float32 { return metricsFor(1).cardGap(scale) }

func bottomPad(scale float32) float32 { return metricsFor(1).bottomPad(scale) }

func paneGrid(s *herdr.Surface, w, h, cw, ch, scale float32) (cols, rows int) {
	return paneGridIn(s, w, h, cw, ch, scale, metricsFor(1))
}

func frameAt(s *herdr.Surface, w, h, cw, ch, scale float32) shown {
	return frameLaid(s, w, h, cw, ch, scale, metricsFor(1))
}

func sidebarSlot(open, full, scale float32) float32 {
	return metricsFor(1).slot(open, full, scale)
}

func mainPaneWidth(winW, slot float32) float32 {
	return winW - slot - outerPad
}
