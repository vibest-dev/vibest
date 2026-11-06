package app

import (
	"bytes"
	"fmt"
	"image/color"
	"runtime"
	"strings"
	"testing"
	"time"

	"encoding/json"
	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"

	"github.com/egoist/mygo/ui"
)

const styleFrame = time.Second / 60

func useStyle(t *testing.T, a *App, style string) {
	t.Helper()
	a.mu.Lock()
	if a.themes.dir == "" {
		a.themes.dir = t.TempDir()
	}
	a.setPaneStyle(style)
	a.mu.Unlock()
}

func styleNow(a *App) (float32, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.style(), a.styleMoving
}

func styledApp(t *testing.T, w, h int, scale float32, hidden bool, mode, style string) (*App, *ui.Tester) {
	t.Helper()
	a, _, tt := coreShellFixture(t, w, h, scale, hidden, mode, func(a *App) { a.themes.settings.PaneStyle = style })
	return a, tt
}

var moving = func() []string {
	l := []string{"Panes", "workspace-list", "tab/t", "New tab", "Hide sidebar", "Show sidebar", "new-workspace"}
	for _, id := range []string{"a", "b"} {
		for _, act := range []string{"split-right", "split-down", "zoom", "close-pane"} {
			l = append(l, act+"/"+id)
		}
	}
	return l
}()

type styleShot map[string]ui.Rect

func shoot(t *testing.T, app *App, tt *ui.Tester) styleShot {
	s := styleShot{}
	for _, l := range append([]string{"sidebar", "tab-bar", "main-column", "window-chrome", "sidebar-gutter"}, moving...) {
		if r, ok := tt.Find(l); ok {
			s[l] = r
		}
	}
	for _, pl := range corePaneGeometries(t, app, tt) {
		s["card/"+pl.id] = pl.card
		s["term/"+pl.id] = pl.term
		s["cells/"+pl.id] = ui.Rect{W: float32(pl.cols), H: float32(pl.rows)}
	}
	return s
}

func sameShot(t *testing.T, what string, got, want styleShot) {
	t.Helper()
	for k, w := range want {
		if g, ok := got[k]; !ok || !nearDip(g.X, w.X) || !nearDip(g.Y, w.Y) || !nearDip(g.W, w.W) || !nearDip(g.H, w.H) {
			t.Fatalf("%s: %s %v, fresh %v", what, k, g, w)
		}
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			t.Fatalf("%s: %s %v is not in a fresh window", what, k, got[k])
		}
	}
}

func within(x, a, b float32) bool {
	return x >= min(a, b)-0.01 && x <= max(a, b)+0.01
}

func TestPaneStyleMovesOnlyTheLayout(t *testing.T) {
	const w, h = 1000, 640
	for _, scale := range []float32{1, 1.25, 2} {
		for _, hidden := range []bool{false, true} {
			for _, mode := range []string{"single", "split", "nested", "zoom"} {
				t.Run(fmt.Sprintf("%v/%v/%s", scale, hidden, mode), func(t *testing.T) {
					fresh := map[string]styleShot{}
					for _, style := range []string{paneCompact, paneComfortable} {
						app, tt := styledApp(t, w, h, scale, hidden, mode, style)
						fresh[style] = shoot(t, app, tt)
					}
					app, _, tt := coreShellFixture(t, w, h, scale, hidden, mode)
					sameShot(t, "start", shoot(t, app, tt), fresh[paneComfortable])
					for _, to := range []string{paneCompact, paneComfortable} {
						from := paneCompact
						if to == paneCompact {
							from = paneComfortable
						}
						start, end := fresh[from], fresh[to]
						p := start["Panes"]
						termAt := [2]int{int((p.X + 40) * scale), int((p.Y + p.H/2) * scale)}
						img := tt.Image()
						term := img.RGBAAt(termAt[0], termAt[1])
						var sideAt [2]int
						var side color.RGBA
						if l, ok := start["workspace-list"]; ok {
							sideAt = [2]int{int((l.X + l.W/2) * scale), int((l.Y + l.H/2) * scale)}
							side = img.RGBAAt(sideAt[0], sideAt[1])
						}
						useStyle(t, app, to)
						tt.Frame()
						last, frames := shoot(t, app, tt), 0
						for {
							tt.Advance(styleFrame)
							frames++
							img := tt.Image()
							if c := img.RGBAAt(termAt[0], termAt[1]); c != term {
								t.Fatalf("to %s frame %d: terminal %v, was %v", to, frames, c, term)
							}
							if sideAt != [2]int{} {
								if c := img.RGBAAt(sideAt[0], sideAt[1]); c != side {
									t.Fatalf("to %s frame %d: sidebar %v, was %v", to, frames, c, side)
								}
							}
							if !tt.Focused("terminal/a") {
								t.Fatalf("to %s frame %d: the terminal lost the keyboard", to, frames)
							}
							now := shoot(t, app, tt)
							for _, l := range moving {
								if _, ok := start[l]; !ok {
									continue
								}
								ownCard := strings.Contains(l, "/") && l != "tab/t"
								a, b, r, q := start[l], end[l], now[l], last[l]
								for i, f := range [][4]float32{{a.X, b.X, r.X, q.X}, {a.Y, b.Y, r.Y, q.Y}, {a.X + a.W, b.X + b.W, r.X + r.W, q.X + q.W}, {a.Y + a.H, b.Y + b.H, r.Y + r.H, q.Y + q.H}} {
									if !ownCard && !within(f[2], f[0], f[1]) || f[2]-f[3] > 4 || f[3]-f[2] > 4 {
										t.Fatalf("to %s frame %d: %s edge %d at %v after %v, from %v to %v", to, frames, l, i, f[2], f[3], f[0], f[1])
									}
								}
							}
							last = now
							if _, moving := styleNow(app); !moving || frames > 60 {
								break
							}
						}
						if frames < 8 {
							t.Fatalf("to %s settled in %d frames: no motion", to, frames)
						}
						sameShot(t, "settled on "+to, shoot(t, app, tt), end)
					}
				})
			}
		}
	}
}

func inCard(r ui.Rect, rad float32, x, y float32) bool {
	if x < r.X-0.01 || y < r.Y-0.01 || x > r.X+r.W+0.01 || y > r.Y+r.H+0.01 {
		return false
	}
	cx := min(max(x, r.X+rad), r.X+r.W-rad)
	cy := min(max(y, r.Y+rad), r.Y+r.H-rad)
	return (x-cx)*(x-cx)+(y-cy)*(y-cy) <= rad*rad+0.01
}

func TestPaneStyleFramesShowOnlyRealCells(t *testing.T) {
	for _, scale := range []float32{1, 1.25} {
		for _, mode := range []string{"single", "split", "nested"} {
			t.Run(fmt.Sprint(scale, mode), func(t *testing.T) {
				a, f, tt := coreShellFixture(t, 1000, 640, scale, false, mode)
				v := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[Hselection text\r\nretained output")
				cell := vtCell(t, tt, v, "a", 0, 0)
				end := vtCell(t, tt, v, "a", 8, 0)
				tt.Press(float32(cell.Min.X+1)/scale, float32(cell.Min.Y+cell.Dy()/2)/scale)
				tt.Move(float32(end.Max.X-1)/scale, float32(end.Min.Y+end.Dy()/2)/scale)
				tt.Release(float32(end.Max.X-1)/scale, float32(end.Min.Y+end.Dy()/2)/scale)
				tt.Command("copy")
				selected := tt.Clipboard()
				if selected == "" {
					t.Fatal("empty real selection")
				}
				coreOutput(t, a, f, tt, "a", "\x1b[?1002h\x1b[?1006h")
				for _, to := range []string{paneCompact, paneComfortable} {
					useStyle(t, a, to)
					tt.Frame()
					for frame := 0; frame < 40; frame++ {
						tt.Advance(styleFrame)
						origin := find(t, tt, "Panes")
						for _, pl := range corePaneGeometries(t, a, tt) {
							rad := a.shell().cardRadius(scale)
							for _, c := range [][2]int{{0, 0}, {pl.cols - 1, 0}, {0, pl.rows - 1}, {pl.cols - 1, pl.rows - 1}} {
								x, y := pl.term.X+float32(c[0])*pl.cw, pl.term.Y+float32(c[1])*pl.ch
								if !inCard(pl.card, rad, x, y) || !inCard(pl.card, rad, x+pl.cw, y+pl.ch) || x+pl.cw > origin.W+.01 || y+pl.ch > origin.H+.01 {
									t.Fatal("drawn VT cell escaped layout", to, frame, pl)
								}
								if pl.id == "a" {
									tt.ClickAt(origin.X+x+pl.cw/2, origin.Y+y+pl.ch/2)
									wantCorePaneInput(t, f, "a", fmt.Sprintf("\x1b[<0;%d;%dM", c[0]+1, c[1]+1))
									wantCorePaneInput(t, f, "a", fmt.Sprintf("\x1b[<0;%d;%dm", c[0]+1, c[1]+1))
								}
							}
						}
						if caret, ok := tt.TextCaret(); ok && (caret.X < origin.X || caret.Y < origin.Y || caret.X+caret.W > origin.X+origin.W+.5 || caret.Y+caret.H > origin.Y+origin.H+.5) {
							t.Fatal("caret outside viewport")
						}
						tt.Command("copy")
						if tt.Clipboard() != selected || a.coreViews["a"] != v || !strings.Contains(v.VT.Text(), "retained output") {
							t.Fatal("layout changed selection/output/renderer")
						}
						if _, moving := styleNow(a); !moving {
							break
						}
					}
				}
				noCoreData(t, f)
			})
		}
	}
}

func TestPaneStyleTurnsBackWithoutAJump(t *testing.T) {
	for _, wait := range []int{3, 10} {
		app, _, tt := coreShellFixture(t, 1000, 640, 1, false, "split")
		start := shoot(t, app, tt)
		useStyle(t, app, paneCompact)
		tt.Frame()
		for range wait {
			tt.Advance(styleFrame)
		}
		before, _ := styleNow(app)
		was := find(t, tt, "Panes")
		useStyle(t, app, paneComfortable)
		tt.Frame()
		tt.Advance(styleFrame)
		after, _ := styleNow(app)
		now := find(t, tt, "Panes")
		if after < before || now.W-was.W > 4 || was.W-now.W > 4 || now.Y-was.Y > 4 || was.Y-now.Y > 4 {
			t.Fatalf("wait %d: style %v -> %v, panes %v -> %v", wait, before, after, was, now)
		}
		tt.Advance(paneStyleMotion.Duration + 2*styleFrame)
		sameShot(t, fmt.Sprintf("wait %d", wait), shoot(t, app, tt), start)
	}
}

func TestPaneStyleRapidTogglesSettleOnTheLast(t *testing.T) {
	app, _, tt := coreShellFixture(t, 1000, 640, 1, false, "single")
	for i, style := range []string{paneCompact, paneComfortable, paneCompact, paneComfortable, paneCompact} {
		useStyle(t, app, style)
		tt.Frame()
		tt.Advance(time.Duration(2+i) * styleFrame)
	}
	tt.Advance(paneStyleMotion.Duration + 2*styleFrame)
	if tt.FramePending() {
		t.Fatal("frames still waiting")
	}
	if v, moving := styleNow(app); v != 0 || moving {
		t.Fatalf("settled at %v, moving %v", v, moving)
	}
	freshApp, fresh := styledApp(t, 1000, 640, 1, false, "single", paneCompact)
	sameShot(t, "rapid", shoot(t, app, tt), shoot(t, freshApp, fresh))
}

func TestPaneStyleOpensWithoutMotion(t *testing.T) {
	app, tt := styledApp(t, 1000, 640, 1, false, "single", paneCompact)
	if v, moving := styleNow(app); v != 0 || moving || tt.FramePending() {
		t.Fatalf("opened at %v, moving %v, frames pending %v", v, moving, tt.FramePending())
	}
	if _, ok := tt.Find("window-chrome"); ok {
		t.Fatal("compact opened on the card shell")
	}
}

func TestPaneStyleReduceMotion(t *testing.T) {
	app, _, tt := coreShellFixture(t, 1000, 640, 1, false, "single")
	useStyle(t, app, paneCompact)
	tt.Frame()
	tt.Advance(3 * styleFrame)
	if v, moving := styleNow(app); v == 0 || v == 1 || !moving {
		t.Fatalf("not moving: %v %v", v, moving)
	}
	tt.SetPreferences(ui.Preferences{ReduceMotion: true, TextScale: 1})
	tt.Frame()
	if v, moving := styleNow(app); v != 0 || moving {
		t.Fatalf("mid-motion reduce motion at %v, moving %v", v, moving)
	}
	useStyle(t, app, paneComfortable)
	tt.Frame()
	if v, moving := styleNow(app); v != 1 || moving {
		t.Fatalf("later switch at %v, moving %v", v, moving)
	}
}

func TestPaneStyleInputDuringTheMotion(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1000, 640, 1, false, "split")
	v := a.coreViews["a"]
	useStyle(t, a, paneCompact)
	tt.Frame()
	tt.Advance(4 * styleFrame)
	if _, moving := styleNow(a); !moving {
		t.Fatal("not moving")
	}
	if err := tt.Click("split-right/b"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return !a.corePending && a.coreState.Version > 0 })
	root := a.coreState.Layout.Tab("t").Root
	if root.First.Pane == nil || root.First.Pane.ID != "a" || root.Second.First.Pane.ID != "b" {
		t.Fatal("mid-motion split retargeted")
	}
	readyCorePane(t, a, tt, a.coreSelection.Pane)
	if a.coreViews["a"] != v {
		t.Fatal("split replaced unrelated VT")
	}
	tt.Type("x")
	wantCorePaneInput(t, f, a.coreAttached[a.coreSelection.Pane].Address, "x")
	useStyle(t, a, paneComfortable)
	tt.Frame()
	r := find(t, tt, "split-right/b")
	tt.Press(r.X+r.W/2, r.Y+r.H/2)
	tt.Advance(paneStyleMotion.Duration)
	tt.Release(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
	for _, req := range coreRequests(f, "terminal.run") {
		var args core.TerminalRunParams
		json.Unmarshal(req, &args)
		if args.CWD == nil || *args.CWD != "/inert/repo" {
			t.Fatal("wrong split CWD", args)
		}
	}
	noCoreData(t, f)
}

func TestPaneStyleReversalAcrossTheCompactEnd(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1000, 640, 1, false, "split")
	held := func(to string, frames int) {
		r := find(t, tt, "zoom/b")
		tt.Press(r.X+r.W/2, r.Y+r.H/2)
		useStyle(t, a, to)
		tt.Frame()
		for range frames {
			tt.Advance(styleFrame)
		}
		tt.Release(r.X+r.W/2, r.Y+r.H/2)
		tt.Frame()
		if a.coreSelection.Zoom != "" && a.coreSelection.Zoom != "b" {
			t.Fatal("held press retargeted zoom")
		}
		id := a.coreSelection.Pane
		if id != "a" && id != "b" {
			t.Fatal("held action retargeted input")
		}
		readyCorePane(t, a, tt, id)
		tt.Type("x")
		wantCorePaneInput(t, f, id, "x")
		if a.coreSelection.Zoom != "" {
			coreAppAct(a, func() { a.zoomPane("b") })
			tt.Frame()
			readyCorePane(t, a, tt, "b")
		}
	}
	for range 3 {
		held(paneCompact, 30)
		held(paneComfortable, 1)
		held(paneCompact, 2)
	}
	useStyle(t, a, paneComfortable)
	tt.Frame()
	tt.Advance(paneStyleMotion.Duration + styleFrame)
	if err := tt.Click("zoom/b"); err != nil {
		t.Fatal(err)
	}
	if a.coreSelection.Zoom != "b" {
		t.Fatal("new settled gesture failed")
	}
	noCoreData(t, f)
}

func TestPaneStyleMetricsStayOnTheirApp(t *testing.T) {
	left, _, tt := coreShellFixture(t, 800, 600, 2, false, "single")
	useStyle(t, left, paneCompact)
	tt.Frame()
	tt.Advance(paneStyleMotion.Duration + 2*styleFrame)
	right := newChromeTestApp()
	if left.shell().cardRadius(2) != 0 || right.shell().cardRadius(2) == 0 {
		t.Fatalf("left %v right %v", left.shell().cardRadius(2), right.shell().cardRadius(2))
	}
}

func TestPaneStyleTabSwitchWaitsForTheSettledShell(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	old := a.coreViews["a"]
	useStyle(t, a, paneCompact)
	tt.Frame()
	tt.Advance(3 * styleFrame)
	navigationRelease(t, tt, "tab/t2")
	if !tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("mid-motion tab lost first character")
	}
	readyCorePane(t, a, tt, "c")
	wantCorePaneInput(t, f, "c", "x")
	tt.Advance(paneStyleMotion.Duration + styleFrame)
	if a.coreViews["a"] != old || a.coreSelection.Tab != "t2" {
		t.Fatal("style handoff changed tab/renderer")
	}
	noCoreData(t, f)
}

func TestPaneStyleResizeFollowsTheSettledShell(t *testing.T) {
	for _, toggles := range []int{1, 2, 5} {
		t.Run(fmt.Sprint(toggles), func(t *testing.T) {
			a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
			for i := range toggles {
				style := paneCompact
				if i%2 == 1 {
					style = paneComfortable
				}
				useStyle(t, a, style)
				tt.Frame()
				tt.Advance(3 * styleFrame)
			}
			tt.Advance(paneStyleMotion.Duration + styleFrame)
			style := paneCompact
			if toggles%2 == 0 {
				style = paneComfortable
			}
			fresh, ft := styledApp(t, 1280, 800, 1, false, "single", style)
			sameShot(t, "settled resize", shoot(t, a, tt), shoot(t, fresh, ft))
			wantCoreViewerControls(t, f, f.channels["a"])
			tt.Type("x")
			wantCorePaneInput(t, f, "a", "x")
			noLegacyNavigation(t, f)
		})
	}
}

var sidebarNames = []string{"sidebar", "sidebar-grip", "workspace-list", "Theme", "Hide sidebar", "Show sidebar", "new-workspace", "machine: Local", "Repo"}

func sidebarRects(tt *ui.Tester) map[string]ui.Rect {
	out := map[string]ui.Rect{}
	for _, name := range sidebarNames {
		if r, ok := tt.Find(name); ok {
			out[name] = r
		}
	}
	return out
}

func sameRects(t *testing.T, what string, got, want map[string]ui.Rect) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %d sidebar parts, want %d", what, len(got), len(want))
	}
	for k, w := range want {
		g, ok := got[k]
		if !ok || !nearDip(g.X, w.X) || !nearDip(g.Y, w.Y) || !nearDip(g.W, w.W) || !nearDip(g.H, w.H) {
			t.Fatalf("%s: %s %v, want %v", what, k, g, w)
		}
	}
}

func sidebarPixels(tt *ui.Tester, r ui.Rect, scale float32) []byte {
	img := tt.Image()
	x0, y0 := int(r.X*scale), int(r.Y*scale)
	x1, y1 := int((r.X+r.W)*scale), int((r.Y+r.H)*scale)
	var b []byte
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			c := img.RGBAAt(x, y)
			b = append(b, c.R, c.G, c.B, c.A)
		}
	}
	return b
}

func fillWorkspaces(t *testing.T, a *App) {
	coreAppAct(a, func() {
		a.coreEdit(func(l *core.Layout) error {
			for i := range 24 {
				p := core.NewPane(core.TerminalRef{CoreID: l.CoreID, Address: fmt.Sprintf("extra-%d", i)})
				l.AddWorkspace(fmt.Sprintf("Extra %d", i), "", "", p)
			}
			return nil
		})
	})
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces) == 25 })
}

func TestPaneStyleLeavesTheSidebarStill(t *testing.T) {
	const scale float32 = 1.25
	app, _, tt := coreShellFixture(t, 1000, 640, scale, false, "single")
	app.sideWidth = 280
	fillWorkspaces(t, app)
	tt.Frame()
	side, grip := find(t, tt, "sidebar"), find(t, tt, "sidebar-grip")
	if side.X != 0 || side.Y != 0 || side.Y+side.H != 640 || grip.X != side.X+side.W || grip.H != side.H {
		t.Fatalf("sidebar %v grip %v, want the full window", side, grip)
	}
	disc, theme := find(t, tt, "Collapse machine: Local"), find(t, tt, "Theme")
	if !nearDip(disc.X-side.X, chrome.Step8) || !nearDip(side.X+side.W-(theme.X+theme.W), chrome.Step8) {
		t.Fatalf("insets disclosure %v theme %v sidebar %v", disc, theme, side)
	}
	row, next := find(t, tt, "Extra 0"), find(t, tt, "Extra 1")
	if gap := next.Y - (row.Y + row.H); !nearDip(gap, 12) {
		t.Fatalf("row gap %v between %v and %v, want the original 5 DIP padding and 2 DIP list gap", gap, row, next)
	}
	app.sideScroll.Y = 1e9
	tt.Frame()
	if app.sideScroll.Y == 0 || app.sideScroll.MaxY == 0 {
		t.Fatalf("list did not scroll: %+v", app.sideScroll)
	}
	scroll := app.sideScroll.Y
	px, py := int((grip.X+grip.W-0.5)*scale), int((side.Y+80)*scale)
	if got := tt.Image().RGBAAt(px, py); !nearColor(got, app.th.Sidebar) {
		t.Fatalf("comfortable grip rule %v, want the sidebar color %v", got, app.th.Sidebar)
	}
	held := sidebarRects(tt)
	shot := sidebarPixels(tt, ui.Rect{X: 0, Y: 0, W: grip.X + grip.W - 1, H: side.H}, scale)
	panes, moved := find(t, tt, "Panes"), false
	for _, to := range []string{paneCompact, paneComfortable} {
		useStyle(t, app, to)
		tt.Frame()
		for frame := 1; ; frame++ {
			sameRects(t, to, sidebarRects(tt), held)
			if got := sidebarPixels(tt, ui.Rect{X: 0, Y: 0, W: grip.X + grip.W - 1, H: side.H}, scale); !bytes.Equal(got, shot) {
				t.Fatalf("%s frame %d: sidebar pixels changed", to, frame)
			}
			if app.sideScroll.Y != scroll {
				t.Fatalf("%s frame %d: scroll %v, want %v", to, frame, app.sideScroll.Y, scroll)
			}
			if end := find(t, tt, "Panes"); !nearDip(end.Y, panes.Y) || !nearDip(end.H, panes.H) || !nearDip(end.X, panes.X) {
				moved = true
			}
			tt.Advance(styleFrame)
			if _, moving := styleNow(app); !moving || frame > 40 {
				want := app.th.Sidebar
				if to == paneCompact {
					want = app.th.SidebarBorder
				}
				if got := tt.Image().RGBAAt(px, py); !nearColor(got, want) {
					t.Fatalf("%s rule %v, want %v", to, got, want)
				}
				break
			}
		}
	}
	if !moved {
		t.Fatal("panes did not move")
	}

	closed, _, tc := coreShellFixture(t, 1000, 640, scale, true, "single")
	if _, ok := tc.Find("sidebar"); ok {
		t.Fatal("closed sidebar is drawn")
	}
	buttons := sidebarRects(tc)
	for _, to := range []string{paneCompact, paneComfortable} {
		useStyle(t, closed, to)
		tc.Frame()
		tc.Advance(paneStyleMotion.Duration)
		if _, ok := tc.Find("sidebar"); ok {
			t.Fatal("style switch opened the sidebar")
		}
		sameRects(t, "closed "+to, sidebarRects(tc), buttons)
	}

	slide, _, ts := coreShellFixture(t, 1000, 640, scale, false, "single")
	fillWorkspaces(t, slide)
	slide.sideScroll.Y = 1e9
	ts.Frame()
	y := slide.sideScroll.Y
	if err := ts.Click("Hide sidebar"); err != nil {
		t.Fatal(err)
	}
	ts.Advance(sidebarMotion.Duration / 3)
	mid := find(t, ts, "sidebar")
	inset := find(t, ts, "Repo").X - mid.X
	useStyle(t, slide, paneCompact)
	ts.Frame()
	now := find(t, ts, "sidebar")
	if now.Y != mid.Y || now.H != mid.H || now.W-mid.W > sideGutter || mid.W-now.W > sideGutter {
		t.Fatalf("style moved the sliding sidebar %v from %v", now, mid)
	}
	if got := find(t, ts, "Repo").X - now.X; !nearDip(got, inset) || slide.sideScroll.Y != y {
		t.Fatalf("inset %v want %v, scroll %v want %v", got, inset, slide.sideScroll.Y, y)
	}
}

func TestHiddenSidebarHasNoResizeStrip(t *testing.T) {
	for _, scale := range []float32{1, 1.25, 2} {
		t.Run(fmt.Sprint(scale), func(t *testing.T) {
			app, _, tt := coreShellFixture(t, 1000, 640, scale, true, "single")
			app.themes.dir = t.TempDir()
			before, saved := app.sideWidth, app.themes.settings.SidebarWidth
			for _, to := range []string{paneCompact, paneComfortable} {
				useStyle(t, app, to)
				tt.Frame()
				for frame := 1; ; frame++ {
					if _, ok := tt.Find("sidebar-grip-edge"); ok {
						t.Fatalf("%s frame %d: hidden sidebar grew a resize strip", to, frame)
					}
					tt.Advance(styleFrame)
					if _, moving := styleNow(app); !moving || frame > 40 {
						break
					}
				}
			}
			panes := find(t, tt, "Panes")
			x, y := panes.X+1, panes.Y+40
			tt.Press(x, y)
			tt.Move(x+40, y)
			tt.Release(x+40, y)
			tt.Frame()
			if app.sideWidth != before || app.themes.settings.SidebarWidth != saved {
				t.Fatalf("drag changed width %v (was %v), saved %v (was %v)", app.sideWidth, before, app.themes.settings.SidebarWidth, saved)
			}
		})
	}
}

func TestPaneStyleShortcutDoesNotPresizeTheOldShell(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS shortcut")
	}
	a, f, tt := coreShellFixture(t, 1000, 640, 1, false, "single")
	old := a.coreViews["a"]
	useStyle(t, a, paneCompact)
	tt.Key(ui.Cmd, ui.KeyB)
	if a.sidebarVisible || !a.styleMoving {
		t.Fatal("shortcut did not toggle during style motion")
	}
	tt.Type("x")
	wantCorePaneInput(t, f, "a", "x")
	tt.Advance(paneStyleMotion.Duration + styleFrame)
	fresh, ft := styledApp(t, 1000, 640, 1, true, "single", paneCompact)
	sameShot(t, "shortcut settled", shoot(t, a, tt), shoot(t, fresh, ft))
	if a.coreViews["a"] != old {
		t.Fatal("shortcut replaced VT")
	}
	noCoreData(t, f)
}

func TestBottomPadDoesNotInventAReserve(t *testing.T) {
	var zero shellMetrics
	if got := zero.bottomPad(1); got != 0 {
		t.Fatalf("bottom 0 became %v", got)
	}
	if got := metricsFor(0).bottomPad(1); got != 2 {
		t.Fatalf("compact bottom %v", got)
	}
	if got := metricsFor(1).bottomPad(1); got != 4 {
		t.Fatalf("comfortable bottom %v", got)
	}
}
