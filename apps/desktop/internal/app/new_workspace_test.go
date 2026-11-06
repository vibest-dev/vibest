package app

import (
	"fmt"
	"testing"
	"time"

	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo/ui"
)

func TestNewWorkspaceTopChromeLayout(t *testing.T) {
	for _, bar := range []ui.TitleBar{{}, {Height: 28, Left: 78}, {Height: 36, Left: 78}, {Height: 48, Left: 78}} {
		for _, width := range []int{300, 1280} {
			for _, scale := range []float32{1, 2} {
				for _, dark := range []bool{false, true} {
					t.Run(fmt.Sprintf("bar=%v/width=%d/scale=%v/dark=%v", bar, width, scale, dark), func(t *testing.T) {
						app, tt := toggleApp(t, width, 600)
						tt.SetTitleBar(bar)
						tt.SetScale(scale)
						tt.SetDark(dark)
						tt.Frame()
						btn := find(t, tt, "new-workspace")
						toggle := find(t, tt, "Hide sidebar")
						if btn.X != toggle.X+toggle.W+chrome.Step4 || btn.Y != toggle.Y || btn.W != app.th.IconButton || btn.H != toggle.H || btn.X+btn.W > float32(width) {
							t.Fatalf("New workspace %v not beside toggle %v within width %d", btn, toggle, width)
						}
						chromeH := max(windowChromeMin, bar.Height)
						if toggle.X < bar.Left || btn.Y < 0 || btn.Y+btn.H > chromeH {
							t.Fatalf("controls overlap native title bar reservation: toggle=%v new=%v title=%v chrome=%v", toggle, btn, bar, chromeH)
						}
						side, theme := find(t, tt, "sidebar"), find(t, tt, "Theme")
						if theme.X+theme.W != side.X+side.W-chrome.Step8 || theme.Y+theme.H != float32(600)-chrome.Step8 {
							t.Fatalf("theme moved from bottom right: theme=%v sidebar=%v", theme, side)
						}
						check := func() {
							t.Helper()
							if now := find(t, tt, "new-workspace"); now != btn {
								t.Fatalf("creation control moved during sidebar slide: %v -> %v", btn, now)
							}
							tab := find(t, tt, "tab/t")
							win := find(t, tt, "window-chrome")
							if tab.Y < win.Y || tab.Y+tab.H > win.Y+win.H+0.5 || tab.X < btn.X+btn.W {
								t.Fatalf("tab %v is not in the header beside new workspace %v", tab, btn)
							}
							count := 0
							for _, label := range tt.Texts() {
								if label == "new-workspace" {
									count++
								}
							}
							if count != 1 {
								t.Fatalf("%d New workspace controls, want exactly one", count)
							}
						}
						check()
						for _, label := range []string{"Hide sidebar", "Show sidebar"} {
							if err := tt.Click(label); err != nil {
								t.Fatal(err)
							}
							for range 7 {
								step(t, tt)
								check()
							}
						}
					})
				}
			}
		}
	}
}

func TestNewWorkspaceChromeHitGaps(t *testing.T) {
	app, f, tt := coreShellFixture(t, 300, 600, 1, false, "single")
	tt.SetTitleBar(ui.TitleBar{Height: 36, Left: 78})
	tt.Frame()
	btn := find(t, tt, "new-workspace")
	for _, p := range [][2]float32{
		{40, 18},
		{btn.X - chrome.Step4/2, btn.Y + btn.H/2},
		{btn.X + btn.W/2, btn.Y - 1},
		{btn.X + btn.W/2, btn.Y + btn.H + 1},
		{30, 580},
	} {
		tt.Press(p[0], p[1])
		tt.Move(p[0]+1, p[1]+1)
		tt.Release(p[0]+1, p[1]+1)
	}
	app.mu.Lock()
	visible := app.sidebarVisible
	app.mu.Unlock()
	if len(coreRequests(f, "terminal.run")) != 0 || !visible {
		t.Fatal("empty chrome/footer hit area activated a button")
	}
	if err := tt.Click("Theme"); err != nil {
		t.Fatal(err)
	}
	if len(tt.Menu()) == 0 {
		t.Fatal("bottom theme control no longer opens its menu")
	}
}

func TestNewWorkspaceCreationFocus(t *testing.T) {
	for _, hidden := range []bool{false, true} {
		for _, activation := range []string{"click", "top-left", "bottom-right", "enter", "space", "cmd-n"} {
			for _, dialog := range []bool{false, true} {
				t.Run(fmt.Sprint(hidden, activation, dialog), func(t *testing.T) {
					a, f, tt := coreShellFixture(t, 1280, 800, 1, hidden, "single")
					release, held := holdCoreMethod(t, f, "terminal.run")
					if activation == "cmd-n" {
						tt.Key(ui.Cmd, ui.KeyN)
					} else if activation == "enter" || activation == "space" {
						r := find(t, tt, "new-workspace")
						tt.Press(r.X+r.W/2, r.Y+r.H/2)
						tt.Release(-10, -10)
						if !tt.Focused("new-workspace") {
							t.Fatal("creation button not keyboard reachable")
						}
						key := ui.KeyEnter
						if activation == "space" {
							key = ui.KeySpace
						}
						tt.Key(0, key)
					} else {
						r := find(t, tt, "new-workspace")
						x, y := r.X+r.W/2, r.Y+r.H/2
						if activation == "top-left" {
							x, y = r.X+1, r.Y+1
						} else if activation == "bottom-right" {
							x, y = r.X+r.W-1, r.Y+r.H-1
						}
						tt.ClickAt(x, y)
					}
					select {
					case <-held:
					case <-time.After(time.Second):
						t.Fatal("button did not dispatch run")
					}
					n := a.coreCapture
					if n == nil {
						t.Fatal("creation has no original capture")
					}
					if !tt.TypeKeyNative(0, ui.KeyX, "x") {
						t.Fatal("creation lost first native character")
					}
					if dialog {
						coreAppAct(a, func() { a.askInWindow("Rename", "", false, func(string) {}) })
						tt.Frame()
					}
					noCoreData(t, f)
					release()
					awaitCoreApp(t, a, func() bool { return !a.corePending && len(a.coreState.Layout.Workspaces) == 2 })
					a.mu.Lock()
					id, shown := a.coreSelection.Pane, a.sidebarVisible
					a.mu.Unlock()
					if id == "a" || len(coreRequests(f, "terminal.run")) != 1 || shown == hidden {
						t.Fatal("creation reused old target/sidebar or ran twice")
					}
					if dialog {
						awaitCorePaintWithoutOwnership(t, a, tt, id)
						if !tt.TypeKeyNative(0, ui.KeyY, "y") || !tt.Focused("Rename") || a.dialog.value != "y" {
							t.Fatal("late creation stole dialog")
						}
						noCoreData(t, f)
					} else {
						readyCorePane(t, a, tt, id)
						wantCorePaneInput(t, f, "t5", "x")
						tt.Type("later")
						wantCorePaneInput(t, f, "t5", "later")
					}
					noCoreData(t, f)
				})
			}
		}
	}
}

func TestNewWorkspaceTopChromeScreenshot(t *testing.T) {
	_, tt, _ := themedApp(t, "")
	tt.SetTitleBar(ui.TitleBar{Height: 36, Left: 78})
	tt.Frame()
	shot(t, tt, "new-workspace-top-sidebar")
}
