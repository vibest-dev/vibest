package app

import (
	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
	"strings"
	"testing"
	"time"
)

func notes(tt *ui.Tester, text string) bool {
	for _, s := range tt.Texts() {
		if strings.Contains(s, text) {
			return true
		}
	}
	return false
}
func navigationNote(a *App) string { a.mu.Lock(); defer a.mu.Unlock(); return a.navigationNote }
func blocked(a *App) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.coreCapture == nil && a.coreBlocked
}
func clickPane(t *testing.T, a *App, tt *ui.Tester, id string) {
	t.Helper()
	r := find(t, tt, "terminal/"+id)
	tt.ClickAt(r.X+r.W/2, r.Y+r.H/2)
	tt.Frame()
}
func rejected(t *testing.T, a *App, f *coreAppFixture, tt *ui.Tester, want string) {
	t.Helper()
	tt.Frame()
	if got := navigationNote(a); got != want || !notes(tt, want) || !blocked(a) {
		t.Fatalf("note=%q shown=%v paused=%v want=%q", got, notes(tt, want), blocked(a), want)
	}
	noCoreData(t, f)
}
func invalidateCoreCaptureProgram(t *testing.T, a *App, f *coreAppFixture, n *coreCapture) {
	t.Helper()
	f.mu.Lock()
	r := f.terminals[n.ref.Address]
	f.mu.Unlock()
	f.report("restarted", r)
	awaitCoreApp(t, a, func() bool { return a.coreState.Programs[n.ref.Address] != n.program })
}
func TestNavigationQuietCancelIsNotALoss(t *testing.T) {
	for _, cause := range []string{"target-command", "control", "blur"} {
		t.Run(cause, func(t *testing.T) {
			a, f, tt, _, release := pendingCoreNavigation(t)
			switch cause {
			case "target-command":
				tt.Key(ui.Cmd, ui.KeyK)
			case "control":
				focusNavigationControl(t, tt, "machine: Local")
			case "blur":
				a.Focus(false)
				a.Focus(true)
			}
			tt.Frame()
			if notes(tt, navigationLost) || !blocked(a) || !notes(tt, navigationPaused) {
				t.Fatal("quiet cancellation was lost or not shown paused")
			}
			release()
			awaitCorePaintWithoutOwnership(t, a, tt, "c")
			if !blocked(a) {
				t.Fatal("late readiness resumed canceled intent")
			}
			tt.KeyUp(ui.KeyA)
			tt.Key(ui.Shift, ui.KeyA)
			tt.Frame()
			if notes(tt, navigationUnsent) {
				t.Fatal("bare key/release reported loss")
			}
			noCoreData(t, f)
			clickPane(t, a, tt, "c")
			readyCorePane(t, a, tt, "c")
			if notes(tt, navigationPaused) {
				t.Fatal("fresh pane activation did not resume")
			}
			tt.TypeKeyNative(0, ui.KeyZ, "z")
			wantCoreInput(t, f, "z")
			noCoreData(t, f)
		})
	}
}
func TestNavigationQuietDeadlineIsNotALoss(t *testing.T) {
	a, f, tt, n, release := pendingCoreNavigation(t)
	deadline, _ := n.ctx.Deadline()
	time.Sleep(time.Until(deadline) + 20*time.Millisecond)
	awaitCoreApp(t, a, func() bool { return a.coreCapture == nil })
	tt.Frame()
	if notes(tt, navigationLost) || !blocked(a) || !notes(tt, navigationPaused) {
		t.Fatal("quiet deadline claimed loss or failed open")
	}
	release()
	coreAppAct(a, func() { a.ShowPane("a") })
	readyCorePane(t, a, tt, "a")
	tt.Type("z")
	wantCoreInput(t, f, "z")
	if blocked(a) || notes(tt, navigationPaused) {
		t.Fatal("fresh activation did not resume")
	}
}
func TestNavigationLossIsKept(t *testing.T) {
	for _, held := range []string{"text", "paste", "composition"} {
		t.Run(held, func(t *testing.T) {
			a, f, tt, n, release := pendingCoreNavigation(t)
			switch held {
			case "text":
				tt.TypeKeyNative(0, ui.KeyX, "x")
			case "paste":
				tt.SetClipboard("p")
				tt.Command("paste")
			case "composition":
				tt.Compose("ce", 2)
			}
			if !n.meaningful && !n.composing {
				t.Fatal("nothing retained")
			}
			a.Focus(false)
			a.Focus(true)
			tt.Frame()
			if !notes(tt, navigationLost) || !notes(tt, navigationPaused) {
				t.Fatal("missing loss/pause")
			}
			release()
			awaitCorePaintWithoutOwnership(t, a, tt, "c")
			navigationRelease(t, tt, "tab/t1")
			tt.Frame()
			a.Focus(false)
			a.Focus(true)
			tt.Frame()
			if !notes(tt, navigationLost) {
				t.Fatal("quiet cancellation erased loss")
			}
			navigationRelease(t, tt, "tab/t1")
			readyCorePane(t, a, tt, "a")
			if blocked(a) || notes(tt, navigationPaused) || !notes(tt, navigationLost) {
				t.Fatal("successful navigation erased loss or remained paused")
			}
			tt.TypeKeyNative(0, ui.KeyZ, "z")
			wantCoreInput(t, f, "z")
			if err := tt.Click("Dismiss"); err != nil {
				t.Fatal(err)
			}
			if notes(tt, navigationLost) {
				t.Fatal("loss not dismissed")
			}
			noCoreData(t, f)
		})
	}
}
func TestNavigationRejectedPasteIsReported(t *testing.T) {
	failing := transfer.New(transfer.NewItem(transfer.Bytes(transfer.URIList, []byte("file:///tmp/a%01b.txt\r\n"))))
	for name, paste := range map[string]func(*ui.Tester){"paste": func(tt *ui.Tester) { tt.Command("paste") }, "pasteAndMatchStyle": func(tt *ui.Tester) { tt.Command("pasteAndMatchStyle") }, "Cmd+V": func(tt *ui.Tester) { tt.Key(ui.Super, ui.KeyV) }} {
		for _, kind := range []string{"oversized", "clipboard failure", "held", "older note"} {
			t.Run(name+"/"+kind, func(t *testing.T) {
				a, f, tt, _, release := pendingCoreNavigation(t)
				want := navigationUnsent
				switch kind {
				case "oversized":
					tt.SetClipboard(strings.Repeat("x", navigationBytes+1))
				case "clipboard failure":
					tt.SetClipboardData(failing)
				case "held":
					tt.TypeKeyNative(0, ui.KeyX, "x")
					tt.SetClipboard(strings.Repeat("p", navigationBytes))
					want = navigationLost
				case "older note":
					want = "Terminal connection changed; unsent input canceled"
					coreAppAct(a, func() { a.navigationNote = want })
					tt.SetClipboardData(failing)
				}
				paste(tt)
				rejected(t, a, f, tt, want)
				release()
				awaitCorePaintWithoutOwnership(t, a, tt, "c")
				clickPane(t, a, tt, "c")
				readyCorePane(t, a, tt, "c")
				tt.TypeKeyNative(0, ui.KeyZ, "z")
				wantCoreInput(t, f, "z")
				noCoreData(t, f)
			})
		}
	}
}
func TestNavigationRejectedTypingIsReported(t *testing.T) {
	for _, ev := range []ui.InputEvent{{Kind: ui.InputText, Text: "x"}, {Kind: ui.InputKeyDown, Key: ui.KeyEnter}, {Kind: ui.InputCompose, Text: "ce"}, {Kind: ui.InputCommand, Text: "paste"}} {
		t.Run(string(ev.Kind)+ev.Text, func(t *testing.T) {
			a, f, tt, n, _ := pendingCoreNavigation(t)
			invalidateCoreCaptureProgram(t, a, f, n)
			a.coreCaptureInput(n, ev)
			rejected(t, a, f, tt, navigationUnsent)
			if a.coreCapture != nil {
				t.Fatal("invalid owner recreated capture")
			}
		})
	}
}
func TestNavigationInvalidCaptureCommandNotices(t *testing.T) {
	for _, tc := range []struct {
		ev   ui.InputEvent
		want string
	}{{ui.InputEvent{Kind: ui.InputKeyDown, Mods: ui.Super, Key: ui.KeyV}, navigationUnsent}, {ui.InputEvent{Kind: ui.InputKeyDown, Mods: ui.Super, Key: ui.KeyLeft}, navigationUnsent}, {ui.InputEvent{Kind: ui.InputKeyDown, Mods: ui.Super, Key: ui.KeyC}, ""}, {ui.InputEvent{Kind: ui.InputCommand, Text: "copy"}, ""}, {ui.InputEvent{Kind: ui.InputCommand, Text: "selectAll"}, ""}} {
		a, f, tt, n, _ := pendingCoreNavigation(t)
		invalidateCoreCaptureProgram(t, a, f, n)
		a.coreCaptureInput(n, tc.ev)
		rejected(t, a, f, tt, tc.want)
		if !notes(tt, navigationPaused) {
			t.Fatal("missing pause hint")
		}
	}
}
func TestNavigationQuietRejectionStaysQuiet(t *testing.T) {
	a, f, tt, n, _ := pendingCoreNavigation(t)
	invalidateCoreCaptureProgram(t, a, f, n)
	for _, ev := range []ui.InputEvent{{Kind: ui.InputKeyDown, Mods: ui.Shift, Key: ui.KeyA}, {Kind: ui.InputKeyUp, Key: ui.KeyA}, {Kind: ui.InputCommand, Text: "copy"}, {Kind: ui.InputCommand, Text: "selectAll"}, {Kind: ui.InputCompose}} {
		a.coreCaptureInput(n, ev)
	}
	tt.Frame()
	if navigationNote(a) != "" || !blocked(a) || !notes(tt, navigationPaused) {
		t.Fatal("quiet stale events claimed loss or resumed")
	}
	noCoreData(t, f)
}
func TestPausedPasteIsReported(t *testing.T) {
	for name, paste := range map[string]func(*ui.Tester){"paste": func(tt *ui.Tester) { tt.Command("paste") }, "pasteAndMatchStyle": func(tt *ui.Tester) { tt.Command("pasteAndMatchStyle") }, "Cmd+V": func(tt *ui.Tester) { tt.Key(ui.Super, ui.KeyV) }} {
		t.Run(name, func(t *testing.T) {
			a, f, tt, _, _ := pendingCoreNavigation(t)
			tt.Key(ui.Cmd, ui.KeyK)
			if !blocked(a) || navigationNote(a) != "" {
				t.Fatal("not quietly paused")
			}
			tt.SetClipboard("p")
			paste(tt)
			rejected(t, a, f, tt, navigationUnsent)
		})
	}
}
