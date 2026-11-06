package app

import (
	"encoding/binary"
	"reflect"
	"testing"
	"time"

	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo/ui"
)

func mainX(t *testing.T, tt *ui.Tester) float32 {
	t.Helper()
	col, ok := tt.Find("main-column")
	if !ok {
		t.Fatal("main-column missing")
	}
	return col.X
}

func step(t *testing.T, tt *ui.Tester) float32 {
	t.Helper()
	tt.Advance(sidebarMotion.Duration / 6)
	return mainX(t, tt)
}

func TestSidebarSlideProgressesBothWays(t *testing.T) {
	app, tt := toggleApp(t, 1280, 800)
	tt.SetTitleBar(ui.TitleBar{Height: 36, Left: 78})
	tt.Frame()
	full := mainX(t, tt)
	if full <= 0 || app.sideMoving {
		t.Fatalf("at rest: main column at %v, moving %v", full, app.sideMoving)
	}
	if err := tt.Click("Hide sidebar"); err != nil {
		t.Fatal(err)
	}
	last := full
	for i := range 4 {
		x := step(t, tt)
		if x >= last || x <= sideGutter || !app.sideMoving {
			t.Fatalf("out, step %d: main column at %v after %v, moving %v", i, x, last, app.sideMoving)
		}
		side, ok := tt.Find("sidebar")
		grip, ok2 := tt.Find("sidebar-grip")
		if !ok || !ok2 || side.X != 0 || side.W != x-3 || grip.X != x-3 || grip.W != 3 {
			t.Fatalf("out, step %d: sidebar %v grip %v beside the main column at %v", i, side, grip, x)
		}
		btn, ok := tt.Find("Show sidebar")
		if !ok || btn.X != 86 || btn.Y != (tabBarHeight-chrome.Light.IconButton)/2 {
			t.Fatalf("out, step %d: toggle at %v", i, btn)
		}
		if _, ok := tt.Find("Hide sidebar"); ok {
			t.Fatalf("out, step %d: two toggles", i)
		}
		tab, ok3 := tt.Find("tab/t")
		win, ok4 := tt.Find("window-chrome")
		create, ok5 := tt.Find("new-workspace")
		if !ok3 || !ok4 || !ok5 || tab.Y < win.Y || tab.Y+tab.H > win.Y+win.H+0.5 || tab.X < create.X+create.W {
			t.Fatalf("out, step %d: tab %v is not in the header beside %v", i, tab, create)
		}
		last = x
	}
	slide(tt)
	if x := mainX(t, tt); x != sideGutter || app.sideMoving {
		t.Fatalf("out: main column at %v, moving %v", x, app.sideMoving)
	}
	if g := find(t, tt, "sidebar-gutter"); g.X != 0 || g.W != sideGutter || g.Y != windowChromeMin {
		t.Fatalf("out: gutter %v", g)
	}
	if _, ok := tt.Find("sidebar"); ok {
		t.Fatal("out: the sidebar is still there")
	}
	if err := tt.Click("Show sidebar"); err != nil {
		t.Fatal(err)
	}
	last = 0
	for i := range 4 {
		x := step(t, tt)
		if x <= last || x >= full {
			t.Fatalf("in, step %d: main column at %v after %v", i, x, last)
		}
		if btn, ok := tt.Find("Hide sidebar"); !ok || btn.X != 86 || btn.Y != (tabBarHeight-chrome.Light.IconButton)/2 {
			t.Fatalf("in, step %d: toggle at %v", i, btn)
		}
		last = x
	}
	slide(tt)
	if x := mainX(t, tt); x != full || app.sideMoving {
		t.Fatalf("in: main column at %v, want %v, moving %v", x, full, app.sideMoving)
	}
}

func TestSidebarSlideTurnsRoundWhereItIs(t *testing.T) {
	app, tt := toggleApp(t, 1280, 800)
	tt.Frame()
	full := mainX(t, tt)
	if err := tt.Click("Hide sidebar"); err != nil {
		t.Fatal(err)
	}
	tt.Advance(sidebarMotion.Duration / 3)
	pre := mainX(t, tt)
	if pre <= 0 || pre >= full {
		t.Fatalf("a third of the way: main column at %v of %v", pre, full)
	}
	if err := tt.Click("Show sidebar"); err != nil {
		t.Fatal(err)
	}
	at := mainX(t, tt)
	if at <= 0 || at > pre || !app.sidebarVisible {
		t.Fatalf("turned round at %v from %v of %v, visible %v", at, pre, full, app.sidebarVisible)
	}
	tt.Advance(sidebarMotion.Duration / 6)
	if back := mainX(t, tt); back <= at || back >= full {
		t.Fatalf("turned round: main column at %v from %v of %v", back, at, full)
	}
	slide(tt)
	if x := mainX(t, tt); x != full {
		t.Fatalf("back in: main column at %v, want %v", x, full)
	}
}

func TestSidebarSlideNotAtStartNorUnderReduceMotion(t *testing.T) {
	app, tt := toggleApp(t, 1280, 800, func(a *App) { a.sidebarVisible = false })
	tt.Frame()
	if x := mainX(t, tt); x != sideGutter || app.sideMoving {
		t.Fatalf("hidden at start: main column at %v, moving %v", x, app.sideMoving)
	}
	tt.Advance(sidebarMotion.Duration / 2)
	if _, ok := tt.Find("sidebar"); ok || mainX(t, tt) != sideGutter {
		t.Fatal("hidden at start: the sidebar slid")
	}
	tt.SetPreferences(ui.Preferences{ReduceMotion: true, TextScale: 1})
	if err := tt.Click("Show sidebar"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if _, ok := tt.Find("sidebar"); !ok || mainX(t, tt) <= 0 || app.sideMoving {
		t.Fatalf("reduce motion: main column at %v, sidebar %v, moving %v", mainX(t, tt), ok, app.sideMoving)
	}
}

func TestSidebarSlideKeepsKeysAndMapsClicksWhereShown(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
	v := coreOutput(t, a, f, tt, "a", "\x1b[?1002h\x1b[?1006h")
	if err := tt.Click("Hide sidebar"); err != nil {
		t.Fatal(err)
	}
	tt.Advance(sidebarMotion.Duration / 3)
	x := mainX(t, tt)
	tt.Type("x")
	wantCorePaneInput(t, f, "a", "x")
	cell := vtCell(t, tt, v, "a", 4, 4)
	tt.ClickAt(float32(cell.Min.X+cell.Max.X)/2, float32(cell.Min.Y+cell.Max.Y)/2)
	wantCorePaneInput(t, f, "a", "\x1b[<0;5;5M")
	wantCorePaneInput(t, f, "a", "\x1b[<0;5;5m")
	tt.ClickAt(x/2, 700)
	noCoreData(t, f)
}

func TestSidebarSlideAsksForItsEndOnce(t *testing.T) {
	for _, mode := range []string{"single", "split"} {
		t.Run(mode, func(t *testing.T) {
			a, f, tt := coreShellFixture(t, 1280, 800, 1, false, mode)
			initial := corePaneGeometries(t, a, tt)
			for _, label := range []string{"Hide sidebar", "Show sidebar"} {
				toggle(t, tt, label)
				for _, p := range corePaneGeometries(t, a, tt) {
					f.mu.Lock()
					channel := f.channels[p.id]
					f.mu.Unlock()
					deadline := time.Now().Add(time.Second)
					for {
						var cols, rows int
						f.mu.Lock()
						for _, frame := range f.controls {
							if frame.channel == channel && frame.kind == 3 && len(frame.body) == 4 {
								cols = int(binary.LittleEndian.Uint16(frame.body))
								rows = int(binary.LittleEndian.Uint16(frame.body[2:]))
							}
						}
						f.mu.Unlock()
						if cols == p.cols && rows == p.rows {
							break
						}
						if time.Now().After(deadline) {
							t.Fatalf("resize %dx%d, painted %dx%d", cols, rows, p.cols, p.rows)
						}
						time.Sleep(time.Millisecond)
					}
				}
				f.mu.Lock()
				before := len(f.controls)
				f.mu.Unlock()
				for range 4 {
					tt.Frame()
				}
				f.mu.Lock()
				for _, frame := range f.controls[before:] {
					if frame.kind == 3 {
						t.Error("resting layout sent another resize")
					}
				}
				f.mu.Unlock()
				tt.Type("x")
				wantCorePaneInput(t, f, "a", "x")
			}
			if !reflect.DeepEqual(initial, corePaneGeometries(t, a, tt)) {
				t.Fatal("roundtrip changed terminal geometry")
			}
			if err := tt.Click("Hide sidebar"); err != nil {
				t.Fatal(err)
			}
			tt.Advance(sidebarMotion.Duration / 3)
			if err := tt.Click("Show sidebar"); err != nil {
				t.Fatal(err)
			}
			slide(tt)
			if !reflect.DeepEqual(initial, corePaneGeometries(t, a, tt)) {
				t.Fatal("reversal changed geometry")
			}
			noLegacyNavigation(t, f)
		})
	}
}

func TestSidebarSlideMovesEveryFrame(t *testing.T) {
	frames := int(sidebarMotion.Duration / (time.Second / 60))
	for _, scale := range []float32{1, 2} {
		for _, width := range []float32{160, 248, 350} {
			full := onPixel(width+3, scale)
			prev := float32(-1)
			for i := 0; i <= frames; i++ {
				w := sidebarSlot(sidebarMotion.Ease(float32(i)/float32(frames)), full, scale)
				if w <= prev && w != full {
					t.Errorf("scale %v width %v frame %d: the sidebar held at %v before landing", scale, width, i, w)
				}
				prev = w
			}
			if prev != full {
				t.Errorf("scale %v width %v: the slide ends at %v, not %v", scale, width, prev, full)
			}
		}
	}
}
