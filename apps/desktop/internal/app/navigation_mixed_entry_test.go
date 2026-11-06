package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
	"vibest-desktop/internal/core"
)

func readyCoreTabs(t *testing.T) (*App, *coreAppFixture, *ui.Tester) {
	t.Helper()
	a, f, tt := coreActivityUI(t)
	coreAppAct(a, func() { a.SelectTab("t2") })
	readyCorePane(t, a, tt, "c")
	coreAppAct(a, func() { a.SelectTab("t1") })
	readyCorePane(t, a, tt, "a")
	return a, f, tt
}
func TestNavigationChronologicalFirstInputAllEntries(t *testing.T) {
	for _, direction := range []string{"c-a", "a-c"} {
		for _, frames := range []string{"held-press-frame", "externally-unframed"} {
			for _, kind := range []string{"text", "commit", "backspace", "enter", "menu-paste"} {
				t.Run(direction+"/"+frames+"/"+kind, func(t *testing.T) {
					a, f, tt := readyCoreTabs(t)
					first, last, dest := "tab/t2", "tab/t1", "a"
					if direction == "a-c" {
						coreAppAct(a, func() { a.SelectTab("t2") })
						readyCorePane(t, a, tt, "c")
						first, last, dest = "tab/t1", "tab/t2", "c"
					}
					for _, label := range []string{first, last} {
						r := find(t, tt, label)
						if frames == "held-press-frame" {
							tt.Press(r.X+r.W/2, r.Y+r.H/2)
						} else {
							tt.PressUnframed(r.X+r.W/2, r.Y+r.H/2)
						}
						tt.ReleaseUnframed(r.X+r.W/2, r.Y+r.H/2)
					}
					want := "x"
					switch kind {
					case "text":
						if !tt.TypeKeyNative(0, ui.KeyX, "x") {
							t.Fatal("first native text ineligible")
						}
					case "commit":
						if !tt.CommitTextNative("x") {
							t.Fatal("first commit ineligible")
						}
					case "backspace":
						tt.KeyUnframed(0, ui.KeyBackspace)
						want = "\x7f"
					case "enter":
						tt.KeyUnframed(0, ui.KeyEnter)
						want = "\r"
					case "menu-paste":
						tt.SetClipboard("p\nq")
						tt.CommandNative("paste")
						want = "p\rq"
					}
					wantCorePaneInput(t, f, dest, want)
					noCoreData(t, f)
					tt.TypeKeyNative(0, ui.KeyY, "y")
					wantCorePaneInput(t, f, dest, "y")
					noCoreData(t, f)
				})
			}
		}
	}
}
func TestNavigationActiveTextDoesNotBypassCommandPreparation(t *testing.T) {
	for _, command := range []string{"paste", "pasteAndMatchStyle"} {
		t.Run(command, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			release, held := holdCoreMethod(t, f, "terminal.attach c")
			tt.KeyUnframed(ui.Cmd, ui.Key2)
			active, _ := tt.TextInputActive()
			if !active {
				t.Fatal("old context not active for preflight probe")
			}
			tt.SetClipboard("p\nq")
			tt.CommandNative(command)
			<-held
			noCoreData(t, f)
			release()
			readyCorePane(t, a, tt, "c")
			wantCorePaneInput(t, f, "c", "p\rq")
			tt.KeyUnframed(0, ui.KeyEnter)
			wantCorePaneInput(t, f, "c", "\r")
			noCoreData(t, f)
		})
	}
}
func TestNavigationCursorlessCommittedPaneAcceptsFirstText(t *testing.T) {
	for _, mode := range []string{"hidden", "visible"} {
		t.Run(mode, func(t *testing.T) {
			a, f, tt := readyCoreTabs(t)
			coreAppAct(a, func() { a.SelectTab("t2") })
			readyCorePane(t, a, tt, "c")
			output := "\x1b[?25l"
			if mode == "visible" {
				output = "\x1b[?25h"
			}
			coreOutput(t, a, f, tt, "c", output)
			navigationRelease(t, tt, "tab/t2")
			if !tt.TypeKeyNative(0, ui.KeyX, "x") {
				t.Fatal("cursor visibility gated native input")
			}
			wantCorePaneInput(t, f, "c", "x")
			anchor, active := tt.TextCaret()
			r := find(t, tt, "terminal/c")
			if !active || anchor.X < r.X || anchor.Y < r.Y || anchor.X+anchor.W > r.X+r.W || anchor.Y+anchor.H > r.Y+r.H {
				t.Fatal("IME anchor outside terminal", anchor, r)
			}
			coreAppAct(a, func() { a.coreEdit(func(l *core.Layout) error { return l.Rename("w1", "metadata only") }) })
			awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Workspaces[0].Label == "metadata only" })
			tt.Frame()
			if !tt.TypeKeyNative(0, ui.KeyY, "y") {
				t.Fatal("metadata disabled native input")
			}
			wantCorePaneInput(t, f, "c", "y")
		})
	}
}
func TestNavigationModalEscapePreflightKeepsReadyBoundary(t *testing.T) {
	for _, ready := range []bool{false, true} {
		a, f, tt, _, release := pendingCoreNavigation(t)
		if ready {
			release()
			readyCorePane(t, a, tt, "c")
		} else {
			tt.Type("held")
		}
		canceled := 0
		d := &dialog{title: "Modal", open: true, run: func(string) { t.Error("unexpected action") }, cancel: func() { canceled++ }}
		coreAppAct(a, func() { a.openDialog(d) })
		tt.Frame()
		tt.TypeKeyNative(0, ui.KeyI, "i")
		if d.value != "i" {
			t.Fatal("modal did not own first input")
		}
		noCoreData(t, f)
		tt.KeyUnframed(0, ui.KeyEscape)
		tt.TypeKeyNative(0, ui.KeyX, "x")
		if a.dialog != nil || canceled != 1 || d.value != "i" {
			t.Fatal("Escape lost modal ownership")
		}
		if ready {
			wantCorePaneInput(t, f, "c", "x")
			navigationRelease(t, tt, "tab/t1")
			tt.SetClipboard("p\nq")
			tt.CommandNative("paste")
			wantCorePaneInput(t, f, "a", "p\rq")
		} else {
			noCoreData(t, f)
		}
		noCoreData(t, f)
	}
}
func TestNavigationSessionLossClearsApplicationPreedit(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	tt.Compose("に", 1)
	if got := vtView(t, a.coreViews["a"]).FieldByName("preedit").String(); got != "に" {
		t.Fatal("missing VT preedit", got)
	}
	noCoreData(t, f)
	focusNavigationControl(t, tt, "Terminals")
	if got := vtView(t, a.coreViews["a"]).FieldByName("preedit").String(); got != "" {
		t.Fatal("preedit outlived owner", got)
	}
	coreAppAct(a, func() { a.ShowPane("a") })
	readyCorePane(t, a, tt, "a")
	tt.Type("x")
	wantCorePaneInput(t, f, "a", "x")
	noCoreData(t, f)
}
