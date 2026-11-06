package app

import (
	"fmt"
	"image/color"
	"testing"

	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo/ui"
)

func machineHeaderCoreApp(t *testing.T) (*App, *coreAppFixture, *ui.Tester) {
	a, f, tt := coreMachineUI(t)
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		f.layout.Workspaces[0].Label = "local repo"
		f.layout.Workspaces[0].Repository = "/repo/.git"
		f.layout.Workspaces[1].Label = "remote repo"
		f.layout.Workspaces[1].Repository = "/repo/.git"
		f.layout.Workspaces[2].Label = "remote tree"
		f.layout.Workspaces[2].Repository = "/repo/.git"
		f.layout.Workspaces[2].Linked = true
	})
	tt.SetDark(false)
	tt.Frame()
	return a, f, tt
}
func machineHeaderApp(t *testing.T) (*App, *machine, *machine, *ui.Tester) {
	a, _, tt := machineHeaderCoreApp(t)
	return a, a.machines[0], a.machines[1], tt
}

func TestMachineHeadersAreNeutral(t *testing.T) {
	for _, name := range []string{"Paper", "Newsprint", "Nord", "TVA Control", "TVA Light"} {
		for _, scale := range []float32{1, 2} {
			t.Run(fmt.Sprintf("%s/scale=%v", name, scale), func(t *testing.T) {
				a, local, remote, tt := machineHeaderApp(t)
				th, ok := chrome.Builtin(name)
				if !ok {
					t.Fatal(name)
				}
				a.themes.light, a.themes.dark = th, th
				tt.SetScale(scale)
				for _, current := range []*machine{local, remote} {
					for _, focused := range []bool{true, false} {
						coreAppAct(a, func() { a.coreActivateMachine(current); a.windowFocused = focused })
						tt.Frame()
						img := tt.Image()
						for _, label := range []string{"machine: Local", "machine: Remote"} {
							r := find(t, tt, label)
							for _, dx := range []float32{1, 3, 5} {
								if got := img.RGBAAt(int((r.X+dx)*scale), int((r.Y+r.H/2)*scale)); !nearColor(got, th.Sidebar) {
									t.Fatalf("%s uses selected/card styling: %v, want sidebar %v", label, got, th.Sidebar)
								}
							}
						}
						owner := "local"
						if current == remote {
							owner = "remote"
						}
						r := find(t, tt, owner+" repo")
						want := th.Row.Pick(true, false, focused).Background
						wantPixel := color.RGBA{R: want.R, G: want.G, B: want.B, A: want.A}
						sidebarPixel := color.RGBA{R: th.Sidebar.R, G: th.Sidebar.G, B: th.Sidebar.B, A: th.Sidebar.A}
						if got := img.RGBAAt(int((r.X-4)*scale), int((r.Y+r.H/2)*scale)); got != wantPixel || got == sidebarPixel {
							t.Fatalf("selected workspace lost distinct styling: %v, want %v", got, want)
						}
					}
				}
			})
		}
	}
}

func TestMachineHeaderKeyboardFocusRing(t *testing.T) {
	a, local, remote, _ := machineHeaderApp(t)
	tt := ui.NewTester(func(c *ui.Context) {
		c.SetTheme(a.th.Widget())
		ui.Column(c).Width(248).Padding(8).Gap(4).Background(a.th.Sidebar).Children(func() {
			a.machineItem(c, local)
			a.machineItem(c, remote)
		})
	}, 300, 160)
	before := append([]byte(nil), tt.Image().Pix...)
	tt.Key(0, ui.KeyTab)
	tt.Key(0, ui.KeyTab)
	if !tt.Focused("machine: Local") {
		t.Fatal("machine title not keyboard reachable")
	}
	changed := false
	for i, p := range tt.Image().Pix {
		if p != before[i] {
			changed = true
			break
		}
	}
	if !changed {
		t.Fatal("keyboard focus has no rendered ring")
	}
	r := find(t, tt, "machine: Local")
	if got := tt.Image().RGBAAt(int(r.X+3), int(r.Y+r.H/2)); !nearColor(got, a.th.Sidebar) {
		t.Fatal("focus ring replaced neutral header with workspace selection fill")
	}
}

func TestMachineTitleNavigationAndFocus(t *testing.T) {
	for _, activation := range []string{"pointer", "enter", "space"} {
		t.Run(activation, func(t *testing.T) {
			a, f, tt := machineHeaderCoreApp(t)
			local, remote := a.machines[0], a.machines[1]
			for _, target := range []*machine{local, remote, remote, local} {
				label := "machine: " + target.label()
				if activation == "pointer" {
					if err := tt.Click(label); err != nil {
						t.Fatal(err)
					}
				} else {
					r := find(t, tt, label)
					tt.Press(r.X+r.W/2, r.Y+r.H/2)
					tt.Release(-10, -10)
					if !tt.Focused(label) {
						t.Fatalf("%s not focused after cancelled press", label)
					}
					key := ui.KeyEnter
					if activation == "space" {
						key = ui.KeySpace
					}
					tt.Key(0, key)
				}
				if target == remote {
					wantRemoteNavigation(t, a, f, tt, "d")
				} else {
					if !tt.TypeKeyNative(0, ui.KeyX, "x") {
						t.Fatal("machine title lost local first character")
					}
					readyCorePane(t, a, tt, "a")
					wantCorePaneInput(t, f, "a", "x")
				}
				if a.machine != target || a.returnFocus {
					t.Fatal("machine title lost navigation/one-shot focus")
				}
			}
		})
	}
}

func TestMachineHeaderScreenshot(t *testing.T) {
	_, _, _, tt := machineHeaderApp(t)
	shot(t, tt, "machine-headers")
	if err := tt.Click("Collapse machine: Remote"); err != nil {
		t.Fatal(err)
	}
	tt.Move(-10, -10)
	tt.Frame()
	shot(t, tt, "machine-headers-collapsed")
}
