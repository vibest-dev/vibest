package app

import (
	"math"

	"github.com/egoist/mygo/ui"
)

func newChromeTestApp() *App { return NewApp("/inert/core-fixture.sock") }

func cardRadius(scale float32) float32 { return metricsFor(1).cardRadius(scale) }

func cardGap(scale float32) float32 { return metricsFor(1).cardGap(scale) }

func bottomPad(scale float32) float32 { return metricsFor(1).bottomPad(scale) }

func sidebarSlot(open, full, scale float32) float32 {
	return metricsFor(1).slot(open, full, scale)
}

func mainPaneWidth(winW, slot float32) float32 {
	return winW - slot - outerPad
}

func inElement(r ui.Rect, w, h float32) bool {
	return r.X > -0.5 && r.Y > -0.5 && r.X+r.W < w+0.5 && r.Y+r.H < h+0.5
}
func onDevicePixel(v, scale float32) bool {
	p := float64(v * scale)
	return math.Abs(p-math.Round(p)) < 0.01
}
