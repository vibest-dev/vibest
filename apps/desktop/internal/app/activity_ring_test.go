package app

import (
	"bytes"
	"fmt"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"
)

func activityRowFixture(t *testing.T, kind string, th *chrome.Theme) (*App, *coreAppFixture, *ui.Tester, string) {
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		coreActivitySeed(f)
		for id, r := range f.terminals {
			r.Reported = id == "a"
			r.Turn = 0
			r.Status = &core.Status{State: "working"}
			f.terminals[id] = r
		}
	})
	coreAppAct(a, func() { a.th = th })
	name := map[string]string{"workspace": "Repo", "tab": "Build"}[kind]
	tt := ui.NewTester(func(c *ui.Context) {
		a.mu.Lock()
		defer a.mu.Unlock()
		c.SetTheme(th.Widget())
		ui.Column(c).Fill().Padding(10).Background(th.Sidebar).Children(func() {
			ui.Row(c).Width(chrome.SidebarMin).Label("fixture").Children(func() {
				switch kind {
				case "tab":
					a.tabButton(c, a.snap.Tabs[0], 0, a.snap.Tabs[:1])
				}
			})
		})
	}, int(chrome.SidebarMin)+20, 80)
	return a, f, tt, name
}

func TestActivityRingPaintOnlyScheduling(t *testing.T) {
	status, present, clipped := "working", true, false
	views, paints := 0, 0
	th := chrome.Light
	tt := ui.NewTester(func(c *ui.Context) {
		views++
		c.SetTheme(th.Widget())
		ui.Box(c).Fill().DrawOver(func(*ui.Painter, ui.Rect) { paints++ }).Children(func() {
			height := th.Slot
			if clipped {
				height = 0
			}
			ui.Box(c).Size(th.Slot, height).Clip().Children(func() {
				if present {
					paintActivity(c, th, status)
				}
			})
		})
	}, 40, 40)
	beforeViews, beforePaints := views, paints
	before := append([]byte(nil), tt.Image().Pix...)
	tt.Advance(time.Second)
	if views != beforeViews || !tt.FramePending() || bytes.Equal(before, tt.Image().Pix) {
		t.Fatalf("ring must animate by paint alone: views +%d, paints +%d, pending=%v", views-beforeViews, paints-beforePaints, tt.FramePending())
	}
	t.Logf("one animated second: View calls +%d, paints +%d", views-beforeViews, paints-beforePaints)
	for _, state := range []string{"done", "idle", "clipped", "absent"} {
		status, present, clipped = state, true, false
		if state == "clipped" || state == "absent" {
			status, clipped, present = "working", state == "clipped", state != "absent"
		}
		tt.Frame()
		beforeViews, beforePaints = views, paints
		before = append(before[:0], tt.Image().Pix...)
		tt.Advance(time.Second)
		if tt.FramePending() || views != beforeViews || paints != beforePaints || !bytes.Equal(before, tt.Image().Pix) {
			t.Fatalf("%s requested work after ring stopped: views +%d, paints +%d", state, views-beforeViews, paints-beforePaints)
		}
	}
}

func TestActivityRingRowBounds(t *testing.T) {
	for _, theme := range chrome.Builtins {
		for _, scale := range []float32{1, 2} {
			for _, kind := range []string{"tab"} {
				t.Run(fmt.Sprintf("%s/%v/%s", theme, scale, kind), func(t *testing.T) {
					th, _ := chrome.Builtin(theme)
					a, f, tt, name := activityRowFixture(t, kind, th)
					tt.SetScale(scale)
					row, text, slot := find(t, tt, "fixture"), find(t, tt, name), find(t, tt, "activity: working")
					for _, state := range []string{"working", "done", "idle"} {
						turn := uint64(0)
						if state == "done" {
							turn = 1
						}
						reportActivity(t, a, f, "a", state, turn, true)
						for _, hover := range []bool{false, true, false} {
							tt.Move(-10, -10)
							if hover {
								tt.Move(text.X+2, text.Y+text.H/2)
							}
							tt.Frame()
							for phase := range 4 {
								if phase > 0 {
									tt.Advance(200 * time.Millisecond)
								}
								if find(t, tt, "fixture") != row || find(t, tt, name) != text {
									t.Fatalf("%s hover=%v phase=%d moved row or name", state, hover, phase)
								}
								label := "activity: " + state
								if hover && kind == "tab" {
									label = "close/t1"
									absent(t, tt, "activity: working", "activity: done")
								} else if state == "idle" {
									absent(t, tt, "activity: working", "activity: done")
									label = ""
								}
								if label != "" && find(t, tt, label) != slot {
									t.Fatalf("%s hover=%v changed slot", state, hover)
								}
								wantAnimation := state == "working" && !(hover && kind == "tab")
								if tt.FramePending() != wantAnimation {
									t.Fatalf("%s hover=%v: animation requested=%v", state, hover, tt.FramePending())
								}
							}
						}
					}
				})
			}
		}
	}
}
