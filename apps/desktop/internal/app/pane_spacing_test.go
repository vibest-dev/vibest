package app

import (
	"fmt"
	"image"
	"math"

	"testing"

	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

func specThemes(t *testing.T) []*chrome.Theme {
	var out []*chrome.Theme
	for _, name := range []string{"Paper", "Newsprint", "Nord"} {
		th, ok := chrome.Builtin(name)
		if !ok {
			t.Fatal(name)
		}
		out = append(out, th)
	}
	return append(out, chrome.Ghostty(chrome.Dark.Terminal))
}

func TestPaneLayoutIsFixedDips(t *testing.T) {
	for _, th := range specThemes(t) {
		for _, scale := range []float32{1, 1.25, 1.5, 2} {
			for _, mode := range []string{"single", "split", "stack", "nested", "zoom"} {
				t.Run(fmt.Sprintf("%s/%v/%s", th.Name, scale, mode), func(t *testing.T) {
					a, f, tt := coreShellFixture(t, 1280, 800, scale, false, mode, func(a *App) { a.themes.light = th; a.themes.settings.FollowSystem = false })
					coreOutput(t, a, f, tt, "a", "populated VT output")
					origin := find(t, tt, "Panes")
					if !onDevicePixel(origin.X, scale) || !onDevicePixel(origin.Y, scale) {
						t.Fatal("off-device origin")
					}
					for _, pl := range corePaneGeometries(t, a, tt) {
						side := sidePad(scale)
						if !near1(pl.term.X-pl.card.X, side, .5/scale) || !near1(pl.term.Y-pl.card.Y, 28, .5/scale) {
							t.Fatal("terminal reserves", pl)
						}
						right := pl.card.X + pl.card.W - pl.term.X - pl.term.W - side
						below := pl.card.Y + pl.card.H - pl.term.Y - pl.term.H - bottomPad(scale)
						if right < -.5/scale-.01 || right >= pl.cw+.5/scale+.01 || below < -.5/scale-.01 || below >= pl.ch+.5/scale+.01 {
							t.Fatal("incomplete cells or extra reserve", pl, right, below)
						}
						b := find(t, tt, "close-pane/"+pl.id)
						if !near1(origin.X+pl.card.X+pl.card.W-b.X-b.W, side, .5/scale) || !near1(b.Y-origin.Y-pl.card.Y, 4, .5/scale) || !nearDip(b.W, 20) || !nearDip(b.H, 20) {
							t.Fatal("close geometry", b, pl)
						}
						tt.Move(b.X+b.W/2, b.Y+b.H/2)
						tt.Frame()
						img := tt.Image()
						px := func(v float32) int { return int(v*scale + .5) }
						fill := img.RGBAAt(px(b.X+5), px(b.Y+b.H/2))
						same := func(x, y int) bool {
							c := img.RGBAAt(x, y)
							return math.Abs(float64(c.R)-float64(fill.R)) < 3 && math.Abs(float64(c.G)-float64(fill.G)) < 3 && math.Abs(float64(c.B)-float64(fill.B)) < 3
						}
						if same(px(b.X+4), px(b.Y)-2) {
							t.Fatal("missing hover fill")
						}
						y := px(b.Y + 4)
						for same(px(b.X+4), y-1) {
							y--
						}
						x := px(b.X + b.W/2)
						for same(x+1, px(b.Y+4)) {
							x++
						}
						if !near1(float32(y)/scale-origin.Y-pl.card.Y, 4, 1/scale) || !near1(origin.X+pl.card.X+pl.card.W-float32(x+1)/scale, side, 1/scale) {
							t.Fatal("hover square differs from actual close bounds")
						}
						tt.Move(-1, -1)
						tt.Frame()
						if pl.id == "a" {
							title := find(t, tt, "a")
							if !near1(title.X, origin.X+pl.card.X+side, .5/scale) || !near1(title.Y+title.H/2, b.Y+b.H/2, .5/scale) {
								t.Fatal("title row not aligned", title, b)
							}
						}
					}
					noCoreData(t, f)
				})
			}
		}
	}
}

func TestDividersMeetPaneBoxes(t *testing.T) {
	for _, font := range []terminal.Options{{}, {Font: terminal.Font{Family: "JetBrains Mono", Size: 14}}} {
		for _, scale := range []float32{1, 1.25, 1.5, 2} {
			for _, mode := range []string{"single", "split", "stack", "nested", "zoom"} {
				t.Run(fmt.Sprintf("%s/%v/%s", font.Font.Family, scale, mode), func(t *testing.T) {
					mark := *chrome.Light
					mark.Divider = ui.Hex("#FF00FF")
					a, f, tt := coreShellFixture(t, 1280, 800, scale, false, mode, func(a *App) {
						a.look = font
						a.look.NoBlink = true
						a.themes.light = &mark
						a.themes.settings.FollowSystem = false
					})
					ps := corePaneGeometries(t, a, tt)
					origin := find(t, tt, "Panes")
					if len(ps) == 1 {
						noCoreData(t, f)
						return
					}
					gap := ui.Rect{X: ps[0].card.X + ps[0].card.W, Y: 0, W: cardGap(scale), H: origin.H}
					if mode == "stack" {
						gap = ui.Rect{X: 0, Y: ps[0].card.Y + ps[0].card.H, W: origin.W, H: cardGap(scale)}
					}
					for _, pl := range ps {
						if overlapUI(gap, pl.head) || overlapUI(gap, pl.term) {
							t.Fatal("divider touches populated pane", gap, pl)
						}
					}
					x, y := origin.X+gap.X+gap.W/2, origin.Y+gap.Y+gap.H/4
					if got := tt.Image().RGBAAt(int(x*scale), int(y*scale)); !nearColor(got, mark.Background) {
						t.Fatal("gap not window background", got)
					}
					selection := a.coreSelection.Pane
					version := a.coreState.Version
					tt.Press(x, y)
					tt.Move(x+2, y+2)
					tt.Release(x+2, y+2)
					awaitCoreApp(t, a, func() bool { return a.coreState.Version > version })
					if a.coreSelection.Pane != selection {
						t.Fatal("divider stole keyboard owner")
					}
					readyCorePane(t, a, tt, selection)
					tt.Type("x")
					wantCorePaneInput(t, f, selection, "x")
					version = a.coreState.Version
					pl := corePaneGeometries(t, a, tt)[0]
					for _, at := range [][2]float32{{origin.X + pl.term.X + .5, origin.Y + pl.term.Y + pl.ch/2}, {origin.X + pl.head.X + 10, origin.Y + pl.head.Y + .5}} {
						tt.Press(at[0], at[1])
						tt.Release(at[0], at[1])
					}
					if a.coreState.Version != version || a.corePending {
						t.Fatal("text/header press grabbed divider")
					}
					noCoreData(t, f)
				})
			}
		}
	}
}

func overlapUI(a, b ui.Rect) bool {
	return a.X < b.X+b.W-0.01 && b.X < a.X+a.W-0.01 && a.Y < b.Y+b.H-0.01 && b.Y < a.Y+a.H-0.01
}

func TestSelectedTabAndRowShareTheCorner(t *testing.T) {
	for _, th := range specThemes(t) {
		if th.Radius != 4 {
			t.Errorf("%s radius %v, want 4", th.Name, th.Radius)
		}
		if th.Name == chrome.GhosttyName {
			continue
		}
		app, f, tt := coreShellFixture(t, 1280, 800, 2, false, "split", func(a *App) { a.themes.light = th; a.themes.dark = th; a.themes.settings.FollowSystem = false })
		publishCoreLayout(t, app, f, func(f *coreAppFixture) {
			f.layout.Workspaces[0].Label = "Repo One"
			f.layout.Workspaces[0].Tabs[0].Label = "shell"
		})
		tt.Frame()
		img := tt.Image()
		tab, ok := tt.Find("shell")
		name, ok2 := tt.Find("terminals-name")
		if !ok || !ok2 {
			t.Fatalf("%s: tab %v row %v", th.Name, ok, ok2)
		}
		tabCut := cornerCut(img, fillBox(img, tab, 2), 2)
		rowCut := cornerCut(img, fillBox(img, name, 2), 2)
		if tabCut < 0 || tabCut != rowCut {
			t.Errorf("%s: tab corner %d px, row corner %d px, want the same", th.Name, tabCut, rowCut)
		}
	}
}

func nearDip(a, b float32) bool { return a-b < 0.01 && b-a < 0.01 }

func near1(a, b, tol float32) bool { return a-b <= tol+0.01 && b-a <= tol+0.01 }

func fillBox(img *image.RGBA, name ui.Rect, scale float32) ui.Rect {
	x, y := int((name.X-2)*scale), int((name.Y+name.H/2)*scale)
	fill := img.RGBAAt(x, y)
	for y > 0 && img.RGBAAt(x, y-1) == fill {
		y--
	}
	mid := y + int(8*scale)
	for x > 0 && img.RGBAAt(x-1, mid) == fill {
		x--
	}
	return ui.Rect{X: float32(x) / scale, Y: float32(y) / scale, W: name.X + name.W - float32(x)/scale, H: name.H}
}

func cornerCut(img *image.RGBA, r ui.Rect, scale float32) int {
	x0, y := int(r.X*scale+0.5), int(r.Y*scale+0.5)
	f := img.RGBAAt(x0+int(r.W*scale)/2, y)
	fill := ui.Color{R: f.R, G: f.G, B: f.B, A: 255}
	for i := 0; i < int(r.W*scale)/2; i++ {
		if nearColor(img.RGBAAt(x0+i, y), fill) {
			return i
		}
	}
	return -1
}

func TestTabAndNewTabShareHeightAndCorner(t *testing.T) {
	for _, th := range specThemes(t) {
		for _, scale := range []float32{1, 1.25, 1.5, 2} {
			name := fmt.Sprintf("%s x%v", th.Name, scale)
			app, f, tt := coreActivityUI(t)
			coreAppAct(app, func() { app.themes.light = th; app.themes.dark = th; app.themes.settings.FollowSystem = false })
			publishCoreLayout(t, app, f, func(f *coreAppFixture) {
				f.layout.Workspaces[0].Tabs[0].ID = "t"
				f.layout.Workspaces[0].Tabs[0].Label = "shell"
				f.layout.Workspaces[0].Tabs[1].ID = "u"
				f.layout.Workspaces[0].Tabs[1].Label = "logs"
			})
			tt.SetScale(scale)
			tt.SetDark(false)
			tt.Frame()
			on, _ := tt.Find("tab/t")
			off, _ := tt.Find("tab/u")
			plus, ok := tt.Find("New tab")
			if !ok {
				t.Fatalf("%s: no new-tab button", name)
			}
			if !nearDip(on.H, th.IconButton) || !nearDip(off.H, th.IconButton) || !nearDip(plus.H, th.IconButton) || !nearDip(plus.W, plus.H) {
				t.Errorf("%s: tab %vx%v, other %vx%v, plus %vx%v, want height %v and a square plus", name, on.W, on.H, off.W, off.H, plus.W, plus.H, th.IconButton)
			}
			if !nearDip(on.Y, plus.Y) || !nearDip(off.Y, plus.Y) {
				t.Errorf("%s: tops %v %v %v differ", name, on.Y, off.Y, plus.Y)
			}
			if title, ok := tt.Find("shell"); !ok || title.Y < on.Y || title.Y+title.H > on.Y+on.H || !nearDip(title.Y+title.H/2, on.Y+on.H/2) {
				t.Errorf("%s: title %v in tab %v", name, title, on)
			}
			tt.Move(plus.X+plus.W/2, plus.Y+plus.H/2)
			tt.Frame()
			plusCut := outsideRun(tt.Image(), plus, scale)
			coreAppAct(app, func() { app.SelectTab("u") })
			tt.Frame()
			on2, _ := tt.Find("tab/t")
			off2, _ := tt.Find("tab/u")
			plus2, _ := tt.Find("New tab")
			if on2 != on || off2 != off || plus2 != plus {
				t.Errorf("%s: selecting moved %v %v %v to %v %v %v", name, on, off, plus, on2, off2, plus2)
			}
			tt.Move(on2.X+on2.W/2, on2.Y+on2.H/2)
			tt.Frame()
			tabCut := outsideRun(tt.Image(), on2, scale)
			if tabCut <= 0 || tabCut != plusCut {
				t.Errorf("%s: tab corner %d px at %v, new-tab corner %d px at %v", name, tabCut, on2, plusCut, plus)
			}
		}
	}
}

func outsideRun(img *image.RGBA, r ui.Rect, scale float32) int {
	x0, y := int(r.X*scale+0.5), int(r.Y*scale+0.5)
	bg := img.RGBAAt(x0+2, y-2)
	n := 0
	for n < int(r.W*scale)/2 && img.RGBAAt(x0+n, y) == bg {
		n++
	}
	return n
}

func TestSmallFontKeepsItsCell(t *testing.T) {
	for _, scale := range []float32{1, 1.25, 1.5, 2} {
		t.Run(fmt.Sprint(scale), func(t *testing.T) {
			a, f, tt := coreGridFixture(t)
			tt.SetScale(scale)
			v := coreOutput(t, a, f, tt, "a", "\x1b[?1000h\x1b[?1006h\x1b[2;3H")
			initial := vtCell(t, tt, v, "a", 0, 0)
			for _, size := range []float32{8, 10, 0} {
				coreAppAct(a, func() { a.fontSize = size })
				readyCorePane(t, a, tt, "a")
				cell := vtCell(t, tt, v, "a", 2, 1)
				state := vtView(t, v)
				font := state.FieldByName("fonts").Index(0)
				if size > 0 && (float32(font.FieldByName("Size").Float()) != size || cell.Dx() >= initial.Dx() || cell.Dy() >= initial.Dy()) {
					t.Fatalf("size=%v scale=%v font=%v cell=%v initial=%v", size, scale, font.FieldByName("Size").Float(), cell, initial)
				}
				if size == 0 && (cell.Dx() != initial.Dx() || cell.Dy() != initial.Dy()) {
					t.Fatal("reset did not restore natural cells")
				}
				cols, rows := v.VT.Size()
				last := vtCell(t, tt, v, "a", cols-1, rows-1)
				r := find(t, tt, "terminal/a")
				if last.Max.Y > int(math.Round(float64((r.Y+r.H)*scale))) || last.Max.X > int(math.Round(float64((r.X+r.W)*scale))) {
					t.Fatal("reported grid exceeds painted terminal")
				}
				caret, ok := tt.TextCaret()
				if !ok || !near1(caret.X, float32(cell.Min.X)/scale, .5) || !near1(caret.Y, float32(cell.Min.Y)/scale, .5) {
					t.Fatalf("caret %v differs from cell %v at %v", caret, cell, scale)
				}
				tt.ClickAt(float32(cell.Min.X+cell.Dx()/2)/scale, float32(cell.Min.Y+cell.Dy()/2)/scale)
				wantCoreInput(t, f, "\x1b[<0;3;2M")
				wantCoreInput(t, f, "\x1b[<0;3;2m")
				f.mu.Lock()
				channel := f.channels["a"]
				f.mu.Unlock()
				wantCoreCellMetrics(t, f, channel, cell.Dx(), cell.Dy())
			}
		})
	}
}
