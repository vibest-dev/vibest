package app

import (
	"bytes"
	"fmt"
	"image"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/chrome"
)

func TestPassiveActivityRenderer(t *testing.T) {
	for _, name := range chrome.Builtins {
		for _, scale := range []float32{1, 2} {
			t.Run(fmt.Sprintf("%s/%v", name, scale), func(t *testing.T) {
				th, _ := chrome.Builtin(name)
				status := "working"
				clicks := 0
				tt := ui.NewTester(func(c *ui.Context) {
					c.SetTheme(th.Widget())
					b := ui.ButtonBase(c.Key("row")).Width(140).Height(24).Padding(0, 10).Gap(6).Background(th.Sidebar).Label("row").Description(activityDescription(status))
					b.Children(func() { ui.Text(c, "Task").Grow(1).MinWidth(0).SingleLine(); paintActivity(c, th, status) })
					if b.Clicked() {
						clicks++
					}
				}, 180, 60)
				tt.SetScale(scale)
				working := find(t, tt, "activity: working")
				row := find(t, tt, "row")
				if working.W != th.Slot || working.H != th.Slot || working.X <= row.X+row.W/2 {
					t.Fatalf("not compact trailing: %v", working)
				}
				var frames []*image.RGBA
				for phase := range 4 {
					if phase > 0 {
						tt.Advance(200 * time.Millisecond)
					}
					frame := image.NewRGBA(tt.Image().Bounds())
					copy(frame.Pix, tt.Image().Pix)
					frames = append(frames, frame)
					if !tt.FramePending() || find(t, tt, "activity: working") != working || find(t, tt, "row") != row {
						t.Fatal("working animation stopped or changed geometry")
					}
					if phase > 0 && bytes.Equal(frames[phase-1].Pix, frame.Pix) {
						t.Fatal("ring did not animate between quarter-cycle samples")
					}
				}
				status = ""
				tt.Frame()
				idle := tt.Image()
				box := image.Rect(int(working.X*scale), int(working.Y*scale), int((working.X+working.W)*scale), int((working.Y+working.H)*scale))
				for phase, frame := range frames {
					ink, workingColor := 0, 0
					for y := range frame.Bounds().Dy() {
						for x := range frame.Bounds().Dx() {
							pixel := frame.RGBAAt(x, y)
							if pixel == idle.RGBAAt(x, y) {
								continue
							}
							if !image.Pt(x, y).In(box) {
								t.Fatalf("ring escaped slot at phase %d: (%d,%d)", phase, x, y)
							}
							ink++
							if nearColor(pixel, th.Working) {
								workingColor++
							}
						}
					}
					if ink < 12 || workingColor == 0 {
						t.Fatalf("phase %d: insufficient ring ink (%d) or working color (%d)", phase, ink, workingColor)
					}
				}
				if tt.FramePending() {
					t.Fatal("absent ring requested animation")
				}
				status = "working"
				tt.Frame()
				tt.ClickAt(working.X+working.W/2, working.Y+working.H/2)
				if clicks != 1 || !tt.Focused("row") {
					t.Fatal("indicator swallowed row activation")
				}
				tt.Move(-10, -10)
				tt.Key(0, ui.KeyTab)
				if !tt.Focused("row") {
					t.Fatal("indicator added a focus stop")
				}
				status = "done"
				tt.Frame()
				if got := find(t, tt, "activity: done"); got != working {
					t.Fatalf("check changed slot: %v -> %v", working, got)
				}
				tt.Advance(time.Second)
				before := append([]byte(nil), tt.Image().Pix...)
				tt.Advance(time.Second)
				if tt.FramePending() || !bytes.Equal(before, tt.Image().Pix) {
					t.Fatal("completion animated")
				}
				status = ""
				tt.Frame()
				absent(t, tt, "activity: working", "activity: done")
				if tt.FramePending() || find(t, tt, "row") != row {
					t.Fatal("empty state animated or changed row")
				}
			})
		}
	}
}
