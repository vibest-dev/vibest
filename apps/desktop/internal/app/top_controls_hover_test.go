package app

import (
	"fmt"
	"image/color"
	"testing"

	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo/ui"
)

func TestSidebarTopControlsExactHoverColors(t *testing.T) {
	for _, name := range chrome.Builtins {
		for _, scale := range []float32{1, 2} {
			for _, hidden := range []bool{false, true} {
				for _, target := range []string{"toggle", "new-workspace"} {
					t.Run(fmt.Sprintf("%s/scale=%v/hidden=%v/%s", name, scale, hidden, target), func(t *testing.T) {
						th, _ := chrome.Builtin(name)
						_, tt := toggleApp(t, 1280, 800, func(a *App) {
							a.themes.light, a.themes.dark = th, th
						})
						tt.SetTitleBar(ui.TitleBar{Height: 36, Left: 78})
						tt.SetScale(scale)
						tt.SetDark(th.Dark)
						tt.Frame()
						label, background := "Hide sidebar", th.Sidebar
						if hidden {
							toggle(t, tt, label)
							label, background = "Show sidebar", th.Background
						}
						if target != "toggle" {
							label = target
						}
						r := find(t, tt, label)
						check := func(stage string, want ui.Color) {
							t.Helper()
							img := tt.Image()
							for _, dx := range []float32{3, r.W - 3} {
								for _, dy := range []float32{-1, 0, 1} {
									got := img.RGBAAt(int((r.X+dx)*scale), int((r.Y+r.H/2+dy)*scale))
									if expected := (color.RGBA{R: want.R, G: want.G, B: want.B, A: want.A}); got != expected {
										t.Fatalf("%s %s: got #%02X%02X%02X alpha=%d, want #%02X%02X%02X alpha=%d", label, stage, got.R, got.G, got.B, got.A, want.R, want.G, want.B, want.A)
									}
								}
							}
						}
						tt.Move(-10, -10)
						check("normal", background)
						tt.Move(r.X+r.W/2, r.Y+r.H/2)
						check("hover", th.Row.Hover.Background)
						tt.Move(-10, -10)
						check("normal after leaving", background)
					})
				}
			}
		}
	}
}
