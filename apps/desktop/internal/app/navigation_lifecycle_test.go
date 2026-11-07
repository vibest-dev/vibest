package app

import (
	"github.com/egoist/mygo/ui"
	"os"
	"strings"
	"testing"
	"time"
	"vibest-desktop/internal/core"
)

func TestNavigationBoundedSequenceCancelsWithoutPrefix(t *testing.T) {
	for _, limit := range []string{"UTF8-bytes", "events", "paste"} {
		t.Run(limit, func(t *testing.T) {
			a, f, tt, n, release := pendingCoreNavigation(t)
			switch limit {
			case "UTF8-bytes":
				if !tt.TypeKeyNative(0, ui.KeyX, strings.Repeat("é", navigationBytes/2)) {
					t.Fatal("native capture inactive")
				}
				if n.bytes != navigationBytes || n.count != 1 {
					t.Fatal("incorrect UTF-8 accounting")
				}
				tt.TypeKeyNative(0, ui.KeyY, "y")
			case "events":
				for range navigationEvents {
					tt.KeyUnframed(0, ui.KeyBackspace)
				}
				if n.count != navigationEvents || len(n.events) > 2*navigationEvents || n.bytes != 0 {
					t.Fatal("incorrect bounded semantic/metadata accounting")
				}
				tt.KeyUnframed(0, ui.KeyEnter)
				tt.Frame()
			case "paste":
				tt.TypeKeyNative(0, ui.KeyX, "x")
				tt.SetClipboard(strings.Repeat("p", navigationBytes))
				tt.Command("paste")
			}
			coreAppAct(a, func() {
				if a.coreCapture != nil || !a.coreBlocked || a.navigationNote == "" || n.events != nil || n.bytes != 0 {
					t.Fatal("overflow retained prefix or failed open")
				}
			})
			release()
			awaitCorePaintWithoutOwnership(t, a, tt, "c")
			tt.Key(0, ui.KeyEnter)
			tt.TypeKeyNative(0, ui.KeyZ, "z")
			noCoreData(t, f)
			coreAppAct(a, func() {
				if a.coreCapture != nil {
					t.Fatal("canceled capture silently recreated")
				}
			})
		})
	}
}
func TestNavigationCancellationOwnership(t *testing.T) {
	for _, reason := range []string{"modal-replacement", "control", "attach-error", "disconnect", "session", "program", "closure", "superseded", "window-blur"} {
		t.Run(reason, func(t *testing.T) {
			a, f, tt, n, release := pendingCoreNavigation(t)
			tt.TypeKeyNative(0, ui.KeyX, "held")
			switch reason {
			case "modal-replacement":
				coreAppAct(a, func() {
					a.askInWindow("First", "", false, func(string) {})
					a.askInWindow("Replacement", "", false, func(string) {})
				})
				tt.Frame()
				tt.TypeKeyNative(0, ui.KeyY, "y")
				if a.dialog.value != "y" || !tt.Focused("Replacement") {
					t.Fatal("modal lost intentional input")
				}
			case "control":
				focusNavigationControl(t, tt, "Terminals")
				tt.Frame()
			case "attach-error":
				f.mu.Lock()
				f.failOnce = map[string]string{"terminal.attach c": "denied"}
				f.mu.Unlock()
				release()
				awaitCoreApp(t, a, func() bool { return a.coreCapture == nil })
			case "disconnect":
				f.peer.Close()
				awaitCoreApp(t, a, func() bool { return !a.coreState.Connected })
			case "session":
				reconnectCoreApp(t, a, f, coreActivitySeed)
			case "program":
				f.mu.Lock()
				r := f.terminals["c"]
				f.mu.Unlock()
				f.report("restarted", r)
				awaitCoreApp(t, a, func() bool { return a.coreState.Programs["c"] == 1 })
			case "closure":
				coreAppAct(a, func() { a.coreEdit(func(l *core.Layout) error { return l.RemovePane("c") }) })
				awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("c") == nil })
				tt.Frame()
			case "superseded":
				navigationRelease(t, tt, "tab/t1")
				tt.Frame()
			case "window-blur":
				a.Focus(false)
				tt.SetFocused(false)
			}
			coreAppAct(a, func() {
				if n.events != nil || n.bytes != 0 || a.coreCapture == n {
					t.Fatal("canceled transaction retained content/ownership")
				}
			})
			release()
			tt.Frame()
			noCoreData(t, f)
		})
	}
}
func TestNavigationDeadlineDoesNotRestartOnInput(t *testing.T) {
	a, f, tt, n, release := pendingCoreNavigation(t)
	deadline, ok := n.ctx.Deadline()
	if !ok {
		t.Fatal("missing deadline")
	}
	tt.TypeKeyNative(0, ui.KeyX, "held")
	again, _ := n.ctx.Deadline()
	if !again.Equal(deadline) {
		t.Fatal("typing restarted deadline")
	}
	if delay := time.Until(deadline); delay > 0 {
		time.Sleep(delay + 20*time.Millisecond)
	}
	awaitCoreApp(t, a, func() bool { return a.coreCapture == nil })
	coreAppAct(a, func() {
		if n.events != nil || n.bytes != 0 || !a.coreBlocked {
			t.Fatal("timeout retained content or allowed old input")
		}
	})
	release()
	awaitCoreApp(t, a, func() bool { return a.coreErrors["c"] != "" || !a.coreState.Connected })
	tt.Frame()
	tt.Key(0, ui.KeyEnter)
	noCoreData(t, f)
}
func TestNavigationIMEWaitsForCommitAndDoesNotSpendTextBudget(t *testing.T) {
	a, f, tt, n, release := pendingCoreNavigation(t)
	tt.KeyDown(ui.KeyJ)
	tt.Compose(strings.Repeat("界", navigationBytes), 0)
	if !n.composing || n.bytes != 0 || len(n.events) != 0 {
		t.Fatal("preedit counted as committed text")
	}
	tt.KeyUp(ui.KeyJ)
	release()
	awaitCorePaintWithoutOwnership(t, a, tt, "c")
	if a.coreCapture != n || !tt.Focused("navigation-input") {
		t.Fatal("paint stole composing session")
	}
	tt.TypeKeyNative(0, ui.KeyX, "界")
	readyCorePane(t, a, tt, "c")
	channel := wantCoreInput(t, f, "界")
	f.mu.Lock()
	want := f.channels["c"]
	f.mu.Unlock()
	if channel != want {
		t.Fatal("wrong destination")
	}
	if n.events != nil || n.bytes != 0 {
		t.Fatal("completed capture retained content")
	}
	noCoreData(t, f)
}
func TestNavigationFirstSurfaceAndEmptySnapshot(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified software VT required")
	}
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) { f.layout.Workspaces = nil; clear(f.terminals) })
	tt := ui.NewTester(a.View, 1280, 800)
	tt.Frame()
	release, held := holdCoreMethod(t, f, "terminal.run")
	coreAppAct(a, func() { a.NewWorkspace() })
	select {
	case <-held:
	case <-time.After(time.Second):
		t.Fatal("creation request missing")
	}
	tt.Frame()
	if !tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("empty destination lacks capture")
	}
	noCoreData(t, f)
	release()
	awaitCoreApp(t, a, func() bool { return a.coreSelection.Pane != "" })
	id := a.coreSelection.Pane
	readyCorePane(t, a, tt, id)
	got := wantCoreInput(t, f, "x")
	f.mu.Lock()
	want := f.channels["t1"]
	f.mu.Unlock()
	if got != want {
		t.Fatal("first input reached wrong newly created terminal")
	}
	noCoreData(t, f)
}
