package app

import (
	"context"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/core"
)

func TestCoreRelativeEditorLinkUsesCurrentForegroundDirectory(t *testing.T) {
	for _, tc := range []struct {
		name, launch, current, want string
		foreground                  bool
	}{
		{"current foreground", "/inert/start", "/inert/current", "/inert/current/src/main.go", true},
		{"relative foreground", "/inert/start", "relative", "/inert/start/src/main.go", true},
		{"invalid foreground", "/inert/start", "/inert/bad\npath", "/inert/start/src/main.go", true},
		{"empty foreground", "/inert/start", "", "/inert/start/src/main.go", true},
		{"missing foreground", "/inert/start", "", "/inert/start/src/main.go", false},
		{"document fallback", "", "", "/inert/repo/src/main.go", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
				r := f.terminals["a"]
				r.CWD = tc.launch
				if tc.foreground {
					r.Foreground = &core.Foreground{PID: 123, Name: "zsh", CWD: tc.current}
				}
				f.terminals["a"] = r
			})
			requests := make(chan editorRequest, 1)
			coreAppAct(a, func() { a.editor = func(_ context.Context, r editorRequest) error { requests <- r; return nil } })
			v := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[Hsrc/main.go:12:3")
			r := vtCell(t, tt, v, "a", 2, 0)
			tt.ClickAtWith(ui.Cmd, float32(r.Min.X+r.Max.X)/2, float32(r.Min.Y+r.Max.Y)/2)
			select {
			case request := <-requests:
				if request.Path != tc.want || request.Line != 12 || request.Column != 3 {
					t.Fatalf("relative editor request = %q:%d:%d, want %q:12:3", request.Path, request.Line, request.Column, tc.want)
				}
			case <-time.After(time.Second):
				t.Fatal("positioned editor request absent")
			}
			noCoreData(t, f)
		})
	}
}

func TestCoreInactivePaneEditorClickRetainsItsOwnIntent(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	awaitCorePaintWithoutOwnership(t, a, tt, "b")
	v := coreOutput(t, a, f, tt, "b", "\x1b[2J\x1b[H/inert/file.go:12:3")
	returned := make(chan struct{})
	requests := make(chan editorRequest, 1)
	coreAppAct(a, func() {
		a.editor = func(_ context.Context, r editorRequest) error { <-returned; requests <- r; return nil }
	})
	r := vtCell(t, tt, v, "b", 2, 0)
	tt.ClickAtWith(ui.Cmd, float32(r.Min.X+r.Max.X)/2, float32(r.Min.Y+r.Max.Y)/2)
	close(returned)
	coreAppAct(a, func() {
		if a.coreSelection.Pane != "b" {
			t.Fatalf("click did not select b: %+v", a.coreSelection)
		}
	})
	select {
	case request := <-requests:
		if request.Path != "/inert/file.go" || request.Line != 12 || request.Column != 3 || !request.Current() {
			t.Fatal("inactive-pane file click invalidated its own original editor intent")
		}
	case <-time.After(time.Second):
		t.Fatal("inactive-pane file click canceled its editor before dispatch")
	}
	noCoreData(t, f)
}

func TestCoreEditorLinkRejectsLaterOwnerChanges(t *testing.T) {
	for _, change := range []string{"navigation", "modal", "program", "reference", "session", "blur", "window"} {
		t.Run(change, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			awaitCorePaintWithoutOwnership(t, a, tt, "b")
			v := coreOutput(t, a, f, tt, "b", "\x1b[2J\x1b[H/inert/file.go:12:3")
			requests := make(chan editorRequest, 1)
			coreAppAct(a, func() { a.editor = func(_ context.Context, r editorRequest) error { requests <- r; return nil } })
			r := vtCell(t, tt, v, "b", 2, 0)
			tt.ClickAtWith(ui.Cmd, float32(r.Min.X+r.Max.X)/2, float32(r.Min.Y+r.Max.Y)/2)
			var request editorRequest
			select {
			case request = <-requests:
			case <-time.After(time.Second):
				t.Fatal("same-gesture editor request absent")
			}
			if !request.Current() {
				t.Fatal("same-gesture editor request already canceled")
			}
			switch change {
			case "navigation":
				coreAppAct(a, func() { a.ShowPane("a") })
			case "modal":
				coreAppAct(a, func() { a.askInWindow("Later modal", "", false, func(string) {}) })
			case "program":
				f.mu.Lock()
				record := f.terminals["b"]
				f.mu.Unlock()
				f.report("restarted", record)
				awaitCoreApp(t, a, func() bool { return a.coreState.Programs["b"] > 0 })
			case "reference":
				publishCoreLayout(t, a, f, func(f *coreAppFixture) {
					record := f.terminals["b"]
					record.Address = "replacement-b"
					f.terminals[record.Address] = record
					f.layout.Pane("b").Terminal.Address = record.Address
				})
				coreAppAct(a, func() {
					if a.coreViews["b"] == v {
						t.Fatal("changed reference kept original renderer")
					}
				})
			case "session":
				f = reconnectCoreApp(t, a, f, coreActivitySeed)
			case "blur":
				a.Focus(false)
			case "window":
				a.WindowClosed()
			}
			if request.Current() {
				t.Fatalf("editor request rebound after %s", change)
			}
			noCoreData(t, f)
		})
	}
}

func TestCoreInactiveLinkGestureDoesNotTakeOrdinarySelection(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	awaitCorePaintWithoutOwnership(t, a, tt, "b")
	v := coreOutput(t, a, f, tt, "b", "\x1b[2J\x1b[H/inert/file.go:12:3\r\nselect these words")
	requests := make(chan editorRequest, 1)
	coreAppAct(a, func() { a.editor = func(_ context.Context, r editorRequest) error { requests <- r; return nil } })
	at := vtCell(t, tt, v, "b", 2, 0)
	tt.ClickAtWith(ui.Cmd, float32(at.Min.X+at.Max.X)/2, float32(at.Min.Y+at.Max.Y)/2)
	select {
	case <-requests:
	case <-time.After(time.Second):
		t.Fatal("editor absent")
	}
	coreAppAct(a, func() {
		if a.coreEditorClick != "" {
			t.Fatal("link activation survived its UI frame")
		}
	})
	readyCorePane(t, a, tt, "b")
	from, to := vtCell(t, tt, v, "b", 0, 1), vtCell(t, tt, v, "b", 5, 1)
	tt.Press(float32(from.Min.X+1), float32(from.Min.Y+from.Dy()/2))
	tt.Move(float32(to.Max.X-1), float32(to.Min.Y+to.Dy()/2))
	tt.Release(float32(to.Max.X-1), float32(to.Min.Y+to.Dy()/2))
	tt.Command("copy")
	if got := tt.Clipboard(); got != "select" {
		t.Fatalf("ordinary VT selection changed: %q", got)
	}
	select {
	case <-requests:
		t.Fatal("ordinary selection opened an editor")
	default:
	}
	noCoreData(t, f)
	tt.Type("later")
	wantCorePaneInput(t, f, "b", "later")
	noCoreData(t, f)
}
