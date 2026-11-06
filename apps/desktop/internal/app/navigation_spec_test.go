package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
)

func TestNavigationDirectionalCaptureAndNoop(t *testing.T) {
	for _, kind := range []string{"paint-before-intent", "paint-after-intent", "no-op"} {
		t.Run(kind, func(t *testing.T) {
			a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
				if kind == "paint-after-intent" {
					f.attachData = map[string]string{"terminal.attach b": "Core fixture ready"}
				}
			})
			awaitCoreApp(t, a, func() bool { return a.coreViews["b"] != nil })
			key := ui.KeyRight
			id := "b"
			if kind == "no-op" {
				key, id = ui.KeyLeft, "a"
			}
			tt.KeyUnframed(ui.Cmd|ui.Alt, key)
			if !tt.TypeKeyNative(0, ui.KeyX, "x") {
				t.Fatal("direction lost first native input")
			}
			if kind != "paint-after-intent" {
				wantCorePaneInput(t, f, id, "x")
			}
			tt.Key(0, ui.KeyEnter)
			if kind == "paint-after-intent" {
				if a.coreCapture == nil || a.coreCapture.count != 2 {
					t.Fatal("missing held directional sequence")
				}
				noCoreData(t, f)
				coreOutput(t, a, f, tt, "b", "\x1b[?9001l")
				readyCorePane(t, a, tt, "b")
				wantCorePaneInput(t, f, "b", "x\r")
			} else {
				wantCorePaneInput(t, f, id, "\r")
			}
			noLegacyNavigation(t, f)
			noCoreData(t, f)
		})
	}
}
func TestNavigationDirectionalErrorAndSupersession(t *testing.T) {
	for _, supersede := range []bool{false, true} {
		a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) { f.attachData = map[string]string{"terminal.attach b": "Core fixture ready"} })
		tt.Key(ui.Cmd|ui.Alt, ui.KeyRight)
		tt.Type("x")
		tt.Key(0, ui.KeyEnter)
		old := a.coreCapture
		if old == nil {
			t.Fatal("directional owner missing")
		}
		if supersede {
			navigationRelease(t, tt, "tab/t2")
			tt.Type("z")
			readyCorePane(t, a, tt, "c")
			wantCorePaneInput(t, f, "c", "z")
		} else {
			f.mu.Lock()
			r := f.terminals["b"]
			f.mu.Unlock()
			f.report("removed", r)
			awaitCoreApp(t, a, func() bool { return a.coreCapture == nil })
			tt.Frame()
			if !a.coreBlocked {
				t.Fatal("removed destination failed open")
			}
		}
		if old.events != nil {
			t.Fatal("failed/superseded intent retained prefix")
		}
		noCoreData(t, f)
	}
}
func TestNavigationResolvedPaneNeedsCommittedSurface(t *testing.T) {
	for _, scope := range []string{"tab", "workspace"} {
		for _, cursor := range []string{"hidden", "visible"} {
			t.Run(scope+"/"+cursor, func(t *testing.T) {
				id, row := "c", "tab/t2"
				if scope == "workspace" {
					id, row = "d", "Other"
				}
				a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
					mode := "\x1b[?25h"
					if cursor == "hidden" {
						mode = "\x1b[?25l"
					}
					f.attachData = map[string]string{"terminal.attach " + id: mode + "Core fixture ready"}
				})
				if scope == "workspace" {
					terminalWorkspace(t, tt, row)
				} else {
					navigationRelease(t, tt, row)
				}
				tt.Type("x")
				tt.Key(0, ui.KeyEnter)
				awaitCoreApp(t, a, func() bool { return a.coreViews[id] != nil })
				tt.Frame()
				if a.coreSelection.Pane != id || a.coreCapture == nil || a.coreCapture.count != 2 || a.coreViews[id].InputReady() {
					t.Fatal("local selection/attach/cursor replaced parsed-paint proof")
				}
				noCoreData(t, f)
				coreOutput(t, a, f, tt, id, "\x1b[?9001l")
				readyCorePane(t, a, tt, id)
				wantCorePaneInput(t, f, id, "x\r")
				noCoreData(t, f)
			})
		}
	}
}
