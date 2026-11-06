package app

import (
	"fmt"
	"github.com/egoist/mygo/ui"
	"testing"
	"time"
	"vibest-desktop/internal/chrome"
)

func headerAccented(t *testing.T, a *App, tt *ui.Tester, id string) bool {
	t.Helper()
	r, ok := tt.Find(paneTitle(a.snap, id))
	if !ok {
		t.Fatal("missing header", id)
	}
	img := tt.Image()
	scale := a.g.scale
	for y := int(r.Y * scale); y < int((r.Y+r.H)*scale); y++ {
		for x := int(r.X * scale); x < int((r.X+r.W)*scale); x++ {
			if nearColor(img.RGBAAt(x, y), a.th.Accent) {
				return true
			}
		}
	}
	return false
}

func TestInactivePaneTintGeometryAndContrast(t *testing.T) {
	for _, name := range []string{"Paper", "Newsprint", "Nord", "TVA Light", "TVA Control"} {
		for _, style := range []string{paneCompact, paneComfortable} {
			for _, scale := range []float32{1, 2} {
				t.Run(fmt.Sprintf("%s/%s/%v", name, style, scale), func(t *testing.T) {
					a, _, tt := coreGridFixture(t)
					th, _ := chrome.Builtin(name)
					coreAppAct(a, func() {
						a.themes.light, a.themes.dark = th, th
						a.themes.settings.FollowSystem = false
						a.themes.settings.PaneStyle = style
					})
					tt.SetScale(scale)
					tt.SetDark(th.Dark)
					tt.Advance(paneStyleMotion.Duration + styleFrame)
					one := readyCorePane(t, a, tt, "a")
					awaitCorePaintWithoutOwnership(t, a, tt, "b")
					a.mu.Lock()
					two := a.coreViews["b"]
					a.mu.Unlock()
					aw, ah := one.VT.Size()
					bw, bh := two.VT.Size()
					r, term := find(t, tt, "inactive/b"), find(t, tt, "terminal/b")
					if r != term || r.Y < find(t, tt, "pane/b").Y+headH {
						t.Fatalf("tint bounds=%v terminal=%v", r, term)
					}
					absent(t, tt, "inactive/a")
					bg := th.Terminal.Background.Mix(th.Foreground, inactiveVeil)
					if got := tt.Image().RGBAAt(int((r.X+r.W/2)*scale), int((r.Y+r.H/2)*scale)); !nearColor(got, bg) {
						t.Fatalf("tint %v want %v", got, bg)
					}
					for _, ink := range []ui.Color{th.Terminal.Foreground, th.Secondary} {
						tinted := ink.Mix(th.Foreground, inactiveVeil)
						if ratio := contrast(tinted, bg); ratio < 4.5 && ratio < contrast(ink, th.Terminal.Background)-.5 {
							t.Fatal("tint degraded contrast")
						}
					}
					if style == paneComfortable {
						card := find(t, tt, "pane/b")
						pixel := tt.Image().RGBAAt(int((card.X+card.W-1)*scale), int((card.Y+card.H-1)*scale))
						if !nearColor(pixel, th.Background) {
							t.Fatal("tint leaked outside rounded card")
						}
					}
					if !headerAccented(t, a, tt, "a") || headerAccented(t, a, tt, "b") {
						t.Fatal("header disagrees with active content")
					}
					coreAppAct(a, func() { a.ShowPane("b") })
					readyCorePane(t, a, tt, "b")
					find(t, tt, "inactive/a")
					absent(t, tt, "inactive/b")
					if !headerAccented(t, a, tt, "b") || headerAccented(t, a, tt, "a") {
						t.Fatal("header did not follow focus")
					}
					cw, ch := one.VT.Size()
					dw, dh := two.VT.Size()
					if aw != cw || ah != ch || bw != dw || bh != dh {
						t.Fatal("visual focus resized terminals")
					}
					a.Focus(false)
					tt.Frame()
					if headerAccented(t, a, tt, "a") || headerAccented(t, a, tt, "b") {
						t.Fatal("blurred header accented")
					}
				})
			}
		}
	}
}
func TestDelayedPaneUsesCurrentThemeAndFont(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	release, held := holdCoreMethod(t, f, "terminal.attach b")
	tt := ui.NewTester(a.View, 1280, 800)
	readyCorePane(t, a, tt, "a")
	select {
	case <-held:
	case <-time.After(time.Second):
		t.Fatal("attach did not reach barrier")
	}
	th, _ := chrome.Builtin("TVA Control")
	coreAppAct(a, func() {
		a.themes.light, a.themes.dark = th, th
		a.themes.settings.FollowSystem = false
		a.fontSize = 20
	})
	tt.SetScale(2)
	tt.Frame()
	release()
	awaitCorePaintWithoutOwnership(t, a, tt, "b")
	r := find(t, tt, "inactive/b")
	bg := th.Terminal.Background.Mix(th.Foreground, inactiveVeil)
	if got := tt.Image().RGBAAt(int((r.X+r.W/2)*2), int((r.Y+r.H/2)*2)); !nearColor(got, bg) {
		t.Errorf("delayed pane tint %v want %v", got, bg)
	}
	a.mu.Lock()
	view := a.coreViews["b"]
	a.mu.Unlock()
	if got := vtView(t, view).FieldByName("fonts").Index(0).FieldByName("Size").Float(); got != 20 {
		t.Errorf("delayed pane font size %v want 20", got)
	}
}

func TestInactivePaneTintSkipsSingleZoomAndTooSmall(t *testing.T) {
	a, _, tt := coreGridFixture(t)
	coreAppAct(a, func() { a.ZoomPane("a") })
	readyCorePane(t, a, tt, "a")
	absent(t, tt, "inactive/a", "inactive/b")
	coreAppAct(a, func() { a.SelectTab("t2") })
	readyCorePane(t, a, tt, "c")
	absent(t, tt, "inactive/c")
	tt.SetSize(80, 60)
	tt.Frame()
	tt.Frame()
	a.mu.Lock()
	ready := a.coreViews["c"].InputReady()
	a.mu.Unlock()
	if ready {
		t.Fatal("too-small terminal retained input")
	}
}
func TestInactivePaneTintClipsToLocalLayout(t *testing.T) {
	a, _, tt := coreGridFixture(t)
	for _, width := range []int{1120, 900, 1280} {
		tt.SetSize(width, 600)
		readyCorePane(t, a, tt, "a")
		awaitCorePaintWithoutOwnership(t, a, tt, "b")
		r, term := find(t, tt, "inactive/b"), find(t, tt, "terminal/b")
		if r != term || r.X+r.W > float32(width)+.5 || r.Y+r.H > 600.5 {
			t.Fatalf("local resize left an offscreen tint: %v", r)
		}
		pixel := tt.Image().RGBAAt(int(r.X+r.W/2), int(r.Y+r.H/2))
		if !nearColor(pixel, a.th.Terminal.Background.Mix(a.th.Foreground, inactiveVeil)) {
			t.Fatal("resize left an untinted content corner")
		}
	}
}
func TestInactivePaneTintPassesThroughToNavigation(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	awaitCorePaintWithoutOwnership(t, a, tt, "b")
	r := find(t, tt, "inactive/b")
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	readyCorePane(t, a, tt, "b")
	find(t, tt, "inactive/a")
	absent(t, tt, "inactive/b")
	tt.Type("destination")
	channel := wantCoreInput(t, f, "destination")
	f.mu.Lock()
	want := f.channels["b"]
	f.mu.Unlock()
	if channel != want {
		t.Fatal("veil click typed into old pane")
	}
	noLegacyNavigation(t, f)
}
