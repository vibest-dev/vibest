package app

import (
	"fmt"
	"github.com/egoist/mygo/ui"
	"math"
	"strings"
	"testing"
)

func TestPaneTitleHasNoDot(t *testing.T) {
	for _, th := range specThemes(t) {
		for _, width := range []int{1280, 520} {
			t.Run(fmt.Sprintf("%s/%d", th.Name, width), func(t *testing.T) {
				a, f, tt := coreShellFixture(t, width, 800, 1, false, "split", func(a *App) { a.themes.light = th; a.themes.dark = th; a.themes.settings.FollowSystem = false })
				title := "a long title that cannot fit in a narrow pane header at all"
				publishCoreLayout(t, a, f, func(f *coreAppFixture) { f.layout.Pane("b").Label = title })
				tt.Frame()
				head := find(t, tt, "pane-header/b")
				name := find(t, tt, title)
				button := find(t, tt, "split-right/b")
				if !nearDip(name.X, head.X+sides) || button.W != headButtonSize || name.X+name.W > button.X-headGap+.01 {
					t.Fatal("title inserted a status slot or overlapped controls", head, name, button)
				}
				if name.Y < head.Y || name.Y+name.H > head.Y+head.H {
					t.Fatal("title escaped committed header")
				}
			})
		}
	}
}
func TestScrollbarStaysInItsColumn(t *testing.T) {
	for _, scale := range []float32{1, 1.25, 1.5, 2} {
		for _, mode := range []string{"single", "split", "stack", "nested", "zoom"} {
			t.Run(fmt.Sprintf("%v/%s", scale, mode), func(t *testing.T) {
				a, f, tt := coreShellFixture(t, 1280, 800, scale, false, mode)
				v := coreOutput(t, a, f, tt, "a", "\x1b[3J\x1b[2J\x1b[H\x1b[?25l"+strings.Repeat(strings.Repeat("W", 24)+"\r\n", 180)+strings.Repeat("W", 24))
				r := find(t, tt, "terminal/a")
				tt.Move(r.X+r.W/2, r.Y+r.H/2)
				before := tt.Image()
				tt.Key(ui.Cmd, ui.KeyHome)
				tt.Frame()
				after := tt.Image()
				changed := 0
				for y := range after.Bounds().Dy() {
					for x := range after.Bounds().Dx() {
						if before.RGBAAt(x, y) == after.RGBAAt(x, y) {
							continue
						}
						changed++
						if float64(x) < math.Floor(float64((r.X+r.W-9)*scale)) || float32(x) >= (r.X+r.W)*scale || float32(y) < r.Y*scale || float32(y) >= (r.Y+r.H)*scale {
							t.Fatalf("scrollbar changed outside original VT edge %d,%d %v", x, y, r)
						}
					}
				}
				if changed == 0 {
					t.Fatal("actual populated VT never showed a scrollbar")
				}
				tt.Key(ui.Cmd, ui.KeyEnd)
				tt.Frame()
				if a.coreViews["a"] != v {
					t.Fatal("scroll replaced renderer")
				}
				tt.Type("later")
				wantCorePaneInput(t, f, "a", "later")
				noCoreData(t, f)
			})
		}
	}
}
