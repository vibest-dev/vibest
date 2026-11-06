//go:build coreapp

package app

import (
	"encoding/json"
	"errors"
	"github.com/egoist/mygo/ui"
	"os"
	"strings"
	"testing"
	"time"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/coreview"
)

func TestCoreAppUsesVTAndShowsRecoverableInputRefusal(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified VT library required")
	}
	a, f := newCoreAppFixture(t)
	coreAppAct(a, a.NewWorkspace)
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces) == 1 && !a.corePending })
	a.mu.Lock()
	first := a.coreSelection.Pane
	a.mu.Unlock()
	tt := ui.NewTester(a.View, 1000, 700)
	ready := func(id string) *coreview.Terminal {
		t.Helper()
		until := time.Now().Add(3 * time.Second)
		for {
			tt.Frame()
			a.mu.Lock()
			v := a.coreViews[id]
			ok := false
			if v != nil {
				_, ok = a.coreKeyboard.CaptureFor(v.Viewer)
			}
			a.mu.Unlock()
			if ok {
				return v
			}
			if time.Now().After(until) {
				a.mu.Lock()
				t.Logf("selection=%+v pending=%v returnFocus=%v coreSelected=%p target=%p errors=%v bounds=%v", a.coreSelection, a.corePending, a.returnFocus, a.coreSelected, a.coreViews[id], a.coreErrors, a.coreBounds)
				if target := a.coreViews[id]; target != nil {
					t.Logf("text=%q inputError=%v", target.VT.Text(), target.InputError())
				}
				a.mu.Unlock()
				t.Fatal("App terminal not rendered/ready: " + id)
			}
			time.Sleep(time.Millisecond)
		}
	}
	next := func(want string) uint32 {
		t.Helper()
		select {
		case p := <-f.inputs:
			if string(p.body) != want {
				t.Fatalf("input %q, want %q", p.body, want)
			}
			return p.channel
		case <-time.After(time.Second):
			t.Fatal("missing App input")
			return 0
		}
	}
	view := ready(first)
	renderer := view.VT
	tt.Type("first")
	firstChannel := next("first")
	old, _ := a.coreKeyboard.CaptureFor(view.Viewer)
	a.Focus(false)
	a.Focus(true)
	ready(first)
	if view.VT != renderer || old.Valid() {
		t.Fatal("focus recreated renderer or revived old capture")
	}
	coreAppAct(a, func() { a.Split(first, "right") })
	awaitCoreApp(t, a, func() bool { return len(a.snap.Panes) == 2 && !a.corePending })
	a.mu.Lock()
	second := a.coreSelection.Pane
	a.mu.Unlock()
	ready(second)
	tt.Type("second")
	if next("second") == firstChannel {
		t.Fatal("split input reached old pane")
	}
	coreAppAct(a, func() { a.ShowPane(first) })
	ready(first)
	tt.Type("returned")
	if next("returned") != firstChannel {
		t.Fatal("focus return reattached terminal")
	}
	a.mu.Lock()
	same := a.coreViews[first].VT == renderer
	a.mu.Unlock()
	if !same {
		t.Fatal("split/focus recreated retained renderer")
	}
	view.VT.Send(make([]byte, 1<<20))
	awaitCoreApp(t, a, func() bool { return strings.Contains(a.navigationNote, "capacity exceeded") })
	tt.Frame()
	tt.Type("after refusal")
	if next("after refusal") != firstChannel {
		t.Fatal("capacity refusal poisoned later typing")
	}
	if !tt.DropFiles(400, 300, "/inert/not-read") {
		t.Fatal("file drop fixture missed terminal")
	}
	tt.Frame()
	if next("'/inert/not-read'") != firstChannel {
		t.Fatal("local drop retargeted terminal")
	}
	noCoreData(t, f)
}

func TestCoreAppRemoteOutputIsReadOnlyWithVisibleReasonAndLocalInputWorks(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified library required")
	}
	p := core.NewPane(core.TerminalRef{CoreID: "remote-A", Address: "rohan/t1"})
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		f.layout.AddWorkspace("Remote", "/inert", "rohan", p)
		f.machines = []core.Machine{{Name: "rohan", ID: "remote-A", State: "connected"}}
		f.terminals["remote-A/t1"] = core.Terminal{Address: "rohan/t1", State: "live", Cols: 80, Rows: 24}
	})
	tt := ui.NewTester(a.View, 1000, 700)
	var remote *coreview.Terminal
	deadline := time.Now().Add(3 * time.Second)
	for {
		tt.Frame()
		a.mu.Lock()
		remote = a.coreViews[p.ID]
		a.mu.Unlock()
		if remote != nil && strings.Contains(remote.VT.Text(), "Core fixture ready") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("remote output unavailable")
		}
		time.Sleep(time.Millisecond)
	}
	tt.Frame()
	if remote.InputReady() || !errors.Is(remote.InputError(), core.ErrRemoteInput) || !tt.HasText(core.ErrRemoteInput.Error()) {
		t.Fatalf("missing read-only contract: ready=%v error=%v UI=%q", remote.InputReady(), remote.InputError(), tt.Texts())
	}
	tt.Type("never send")
	remote.VT.Paste("nor paste")
	f.send(2, []byte("\r\n[line loss is just output]\r\n\x1b[2Jreplacement shell\x1b[?9001l"))
	a.Focus(false)
	a.Focus(true)
	deadline = time.Now().Add(3 * time.Second)
	for !strings.Contains(remote.VT.Text(), "replacement shell") {
		tt.Frame()
		if time.Now().After(deadline) {
			t.Fatal("remote replacement output lost")
		}
		time.Sleep(time.Millisecond)
	}
	tt.Frame()
	tt.Type("still refused")
	if remote.InputReady() {
		t.Fatal("transparent reattachment revived input")
	}
	select {
	case got := <-f.inputs:
		t.Fatalf("remote emitted human input: %q", got.body)
	default:
	}
	coreAppAct(a, func() { a.coreActivateMachine(a.machines[0]); a.NewWorkspace() })
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces) == 2 && !a.corePending })
	deadline = time.Now().Add(3 * time.Second)
	for {
		tt.Frame()
		a.mu.Lock()
		local := a.coreViews[a.coreSelection.Pane]
		a.mu.Unlock()
		if local != nil && local.InputReady() {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("local input unavailable")
		}
		time.Sleep(time.Millisecond)
	}
	tt.Type("local works")
	select {
	case got := <-f.inputs:
		if got.channel == 2 || string(got.body) != "local works" {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("missing local input")
	}
	coreAppAct(a, func() {
		a.ClosePane(p.ID)
		d := a.dialog
		a.dialog = nil
		if d == nil {
			t.Fatal("missing confirmation")
		}
		d.run("")
	})
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane(p.ID) == nil })
	f.mu.Lock()
	defer f.mu.Unlock()
	killed := false
	for i, method := range f.methods {
		if method == "terminal.kill" {
			killed = true
			var args struct{ Terminal string }
			json.Unmarshal(f.params[i], &args)
			if args.Terminal != "remote-A/t1" {
				t.Fatal("App close used mutable alias", args.Terminal)
			}
		}
	}
	if !killed {
		t.Fatal("App removed pane without issuing the confirmed kill")
	}
}

func TestCoreAppCompositionPasteAndDialogIsolation(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	view := readyCorePane(t, a, tt, "a")
	tt.Compose("候補", 2)
	select {
	case p := <-f.inputs:
		t.Fatalf("preedit sent %q", p.body)
	default:
	}
	tt.Type("確定")
	channel := wantCoreInput(t, f, "確定")
	f.send(channel, []byte("\x1b[?2004h\r\npaste mode ready\r\n"))
	deadline := time.Now().Add(time.Second)
	for !strings.Contains(view.VT.Text(), "paste mode ready") {
		if time.Now().After(deadline) {
			t.Fatal("paste mode output not parsed")
		}
		tt.Frame()
		time.Sleep(time.Millisecond)
	}
	tt.SetClipboard("one\ntwo")
	tt.Command("paste")
	if wantCoreInput(t, f, "\x1b[200~one\ntwo\x1b[201~") != channel {
		t.Fatal("paste changed owner")
	}
	tt.Command("selectAll")
	tt.Command("copy")
	if !strings.Contains(tt.Clipboard(), "Core fixture ready") {
		t.Fatal("local selection/copy lost output")
	}
	owner, _ := a.coreKeyboard.CaptureFor(view.Viewer)
	coreAppAct(a, func() {
		a.askInWindow("Local dialog", "", false, func(string) { t.Error("unexpected dialog confirmation") })
	})
	tt.Frame()
	tt.Type("dialog only")
	if owner.Valid() {
		t.Fatal("dialog kept terminal input ownership")
	}
	select {
	case p := <-f.inputs:
		t.Fatalf("dialog text reached Core: %q", p.body)
	default:
	}
	if err := tt.Click("Cancel"); err != nil {
		t.Fatal(err)
	}
	returned := readyCorePane(t, a, tt, "a")
	if returned != view {
		t.Fatal("dialog recreated renderer")
	}
	tt.Type("after dialog")
	if wantCoreInput(t, f, "after dialog") != channel {
		t.Fatal("dialog return changed destination")
	}
}

func TestCoreAppTerminalMenuKeepsEditingAndPaneActions(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	view := readyCorePane(t, a, tt, "a")
	tt.Command("selectAll")
	if err := tt.RightClick("terminal/a"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Copy"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tt.Clipboard(), "Core fixture ready") {
		t.Fatal("application menu displaced VT copy")
	}
	tt.SetClipboard("menu paste")
	if err := tt.RightClick("terminal/a"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Paste"); err != nil {
		t.Fatal(err)
	}
	wantCoreInput(t, f, "menu paste")
	if err := tt.RightClick("terminal/b"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Split right"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return a.coreState.Version == 1 })
	coreAppAct(a, func() {
		root := a.coreState.Layout.Tab("t1").Root
		if root.Second.First == nil || root.Second.First.Pane.ID != "b" {
			t.Fatal("menu split did not target hovered pane")
		}
	})
	if a.coreViews["a"] != view {
		t.Fatal("pane menu recreated unrelated VT")
	}
	noLegacyNavigation(t, f)
}
