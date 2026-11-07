package app

import (
	"fmt"
	"github.com/egoist/mygo/ui"
	"testing"
	"time"
)

const oneFrame = time.Second / 60

func headersOnCards(t *testing.T, tt *ui.Tester, a *App, when string) map[string]float32 {
	t.Helper()
	area := find(t, tt, "Panes")
	places := corePaneGeometries(t, a, tt)
	if len(places) == 0 {
		t.Fatal("nothing painted")
	}
	xs := map[string]float32{}
	for _, pl := range places {
		var previous ui.Rect
		for _, kind := range []string{"split-right", "split-down", "zoom", "close-pane"} {
			b := find(t, tt, kind+"/"+pl.id)
			local := ui.Rect{X: b.X - area.X, Y: b.Y - area.Y, W: b.W, H: b.H}
			if !inElement(local, area.W, area.H) || local.X < pl.head.X || local.Y < pl.head.Y || local.X+local.W > pl.head.X+pl.head.W+.01 || local.Y+local.H > pl.head.Y+pl.head.H+.01 {
				t.Fatalf("%s: %s outside its committed header %v: %v", when, kind, pl.head, local)
			}
			if previous.W > 0 && rectsOverlap(previous, b) {
				t.Fatal("header actions overlap")
			}
			previous = b
			if kind == "close-pane" {
				xs[pl.id] = b.X
			}
		}
	}
	return xs
}
func TestSidebarToggleKeepsHeadersOnTheirCards(t *testing.T) {
	for _, tc := range []struct {
		mode    string
		instant bool
	}{{"single", false}, {"split", false}, {"single", true}} {
		t.Run(fmt.Sprint(tc), func(t *testing.T) {
			a, f, tt := coreShellFixture(t, 1280, 800, 1, false, tc.mode)
			if tc.instant {
				tt.SetPreferences(ui.Preferences{ReduceMotion: true, TextScale: 1})
			}
			original := a.coreViews["a"]
			coreOutput(t, a, f, tt, "a", "populated terminal output\r\n")
			width := find(t, tt, "Panes").W
			play := func(n int, dir float32) {
				var last map[string]float32
				for i := range n {
					if i == 1 || i == n/2 {
						coreOutput(t, a, f, tt, "a", "\x1b[2;1Hbackground update")
					}
					tt.Advance(oneFrame)
					xs := headersOnCards(t, tt, a, fmt.Sprint(i))
					for id, x := range xs {
						if prev, ok := last[id]; ok && (x-prev)*dir < -.01 {
							t.Fatal("header moved opposite to card", id, x, prev)
						}
					}
					last = xs
					if a.coreViews["a"] != original {
						t.Fatal("slide replaced terminal")
					}
					if !tt.TypeKeyNative(0, ui.KeyX, "x") {
						t.Fatal("slide lost native input owner")
					}
					wantCorePaneInput(t, f, "a", "x")
				}
			}
			frames := int(sidebarMotion.Duration/oneFrame) + 3
			a.toggleSidebarForTest()
			play(frames, -1)
			if find(t, tt, "Panes").W != mainPaneWidth(1280, sideGutter) {
				t.Fatal("hidden width")
			}
			a.toggleSidebarForTest()
			play(frames, 1)
			if find(t, tt, "Panes").W != width {
				t.Fatal("restored width")
			}
			if !tc.instant {
				a.toggleSidebarForTest()
				play(4, -1)
				a.toggleSidebarForTest()
				play(frames, 1)
			}
			noCoreData(t, f)
		})
	}
}
