package app

import (
	"bytes"
	"errors"
	"github.com/egoist/mygo/ui"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func pendingCoreNavigation(t *testing.T) (*App, *coreAppFixture, *ui.Tester, *coreCapture, func()) {
	t.Helper()
	a, f, tt, release, _ := delayedCoreDestination(t, "attach")
	a.mu.Lock()
	n := a.coreCapture
	a.mu.Unlock()
	if n == nil {
		t.Fatal("navigation did not capture original intent")
	}
	return a, f, tt, n, release
}
func noCoreData(t *testing.T, f *coreAppFixture) {
	t.Helper()
	select {
	case p := <-f.inputs:
		t.Fatalf("unexpected DATA on %d: %q", p.channel, p.body)
	default:
	}
}
func TestCoreNavigationRetainsChronologicalFirstInput(t *testing.T) {
	a, f, tt, release, _ := delayedCoreDestination(t, "attach")
	if !tt.TypeKeyNative(0, ui.KeyX, "x") {
		t.Fatal("pending destination has no native capture context")
	}
	tt.Key(0, ui.KeyLeft)
	tt.SetClipboard("paste\ntext")
	tt.Command("paste")
	tt.TypeKeyNative(0, ui.KeyY, "y")
	noCoreData(t, f)
	release()
	readyCorePane(t, a, tt, "c")
	got := wantCoreInput(t, f, "x\x1b[Dpaste\rtexty")
	f.mu.Lock()
	want := f.channels["c"]
	f.mu.Unlock()
	if got != want {
		t.Fatal("retained input reached wrong target")
	}
	tt.Type("after")
	wantCoreInput(t, f, "after")
	noLegacyNavigation(t, f)
}
func TestCoreNavigationOverflowCancelsWithoutPrefix(t *testing.T) {
	a, f, tt, n, release := pendingCoreNavigation(t)
	tt.Type("prefix")
	tt.Type(strings.Repeat("x", navigationBytes))
	coreAppAct(a, func() {
		if a.coreCapture != nil || !a.coreBlocked || n.events != nil || a.navigationNote != navigationLost {
			t.Fatal("overflow did not discard entire intent")
		}
	})
	release()
	awaitCorePaintWithoutOwnership(t, a, tt, "c")
	noCoreData(t, f)
	coreAppAct(a, func() { a.ShowPane("c") })
	readyCorePane(t, a, tt, "c")
	tt.Type("fresh")
	wantCoreInput(t, f, "fresh")
}
func TestCoreNavigationCompositionStaysWithIntent(t *testing.T) {
	a, f, tt, n, release := pendingCoreNavigation(t)
	tt.Compose("候補", 1)
	coreAppAct(a, func() {
		if n.bytes != 0 || len(n.events) != 0 || !n.composing {
			t.Fatal("preedit spent text budget")
		}
	})
	release()
	awaitCorePaintWithoutOwnership(t, a, tt, "c")
	tt.Frame()
	if !tt.Focused("navigation-input") {
		t.Fatal("paint stole pending composition")
	}
	noCoreData(t, f)
	tt.Type("確定")
	readyCorePane(t, a, tt, "c")
	wantCoreInput(t, f, "確定")
}
func TestCoreNavigationReplacementDropsRetainedInput(t *testing.T) {
	for _, cause := range []string{"new-intent", "blur", "modal", "program", "session", "timeout"} {
		t.Run(cause, func(t *testing.T) {
			a, f, tt, n, release := pendingCoreNavigation(t)
			tt.Type("never replay")
			switch cause {
			case "new-intent":
				coreAppAct(a, func() { a.ShowPane("b") })
			case "blur":
				a.Focus(false)
			case "modal":
				coreAppAct(a, func() { a.askInWindow("Later", "", false, func(string) {}) })
			case "program":
				f.mu.Lock()
				r := f.terminals["c"]
				f.mu.Unlock()
				f.report("restarted", r)
				awaitCoreApp(t, a, func() bool { return a.coreState.Programs["c"] == 1 })
			case "session":
				reconnectCoreApp(t, a, f, coreActivitySeed)
			case "timeout":
				n.cancel()
				awaitCoreApp(t, a, func() bool { return a.coreCapture == nil })
			}
			release()
			tt.Frame()
			coreAppAct(a, func() {
				if n.events != nil {
					t.Fatal("invalid intent retained text")
				}
			})
			noCoreData(t, f)
		})
	}
}
func TestCoreNavigationCreationWaitsForItsOwnResult(t *testing.T) {
	a, f, tt, release, target := delayedCoreDestination(t, "creation")
	if !tt.TypeKeyNative(0, ui.KeyX, "created") {
		t.Fatal("creation lacked native input capture")
	}
	noCoreData(t, f)
	release()
	id := target()
	readyCorePane(t, a, tt, id)
	got := wantCoreInput(t, f, "created")
	f.mu.Lock()
	want := f.channels["t5"]
	f.mu.Unlock()
	if got != want {
		t.Fatal("creation sent to old terminal")
	}
}
func TestCoreNavigationPendingResponseDoesNotBlockUI(t *testing.T) {
	a, f, tt, release, _ := delayedCoreDestination(t, "attach")
	tt.Type("held")
	start := time.Now()
	tt.Key(ui.Cmd, ui.KeyB)
	tt.Type("more")
	if time.Since(start) > time.Second {
		t.Fatal("blocked peer blocked UI")
	}
	noCoreData(t, f)
	release()
	readyCorePane(t, a, tt, "c")
	wantCoreInput(t, f, "heldmore")
}

type coreBlockedWrite struct {
	net.Conn
	entered  chan struct{}
	release  <-chan struct{}
	payload  string
	fail     bool
	attempts atomic.Int32
}

func (c *coreBlockedWrite) Write(p []byte) (int, error) {
	payload := c.payload
	if payload == "" {
		payload = "admitted-before"
	}
	if len(p) > 9 && p[4] == 0 && (p[0] != 0 || p[1] != 0 || p[2] != 0 || p[3] != 0) {
		c.attempts.Add(1)
	}
	if len(p) > 9 && p[4] == 0 && bytes.Equal(p[9:], []byte(payload)) {
		close(c.entered)
		<-c.release
		if c.fail {
			return 0, errors.New("fixture zero-byte DATA failure")
		}
	}
	return c.Conn.Write(p)
}
func TestCoreNavigationBlockedWriterDoesNotBlockUI(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified software VT required")
	}
	entered, gate := make(chan struct{}), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		coreActivitySeed(f)
		f.wrap = func(c net.Conn) net.Conn { return &coreBlockedWrite{Conn: c, entered: entered, release: gate} }
	})
	t.Cleanup(release)
	tt := ui.NewTester(a.View, 1280, 800)
	readyCorePane(t, a, tt, "a")
	_, healthy, other := coreActivityUI(t)
	tt.Type("admitted-before")
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("actual writer did not block")
	}
	start := time.Now()
	navigationRelease(t, tt, "tab/t2")
	tt.TypeKeyNative(0, ui.KeyX, "held")
	tt.Key(ui.Cmd, ui.KeyB)
	tt.Type("more")
	other.Type("healthy")
	wantCoreInput(t, healthy, "healthy")
	if time.Since(start) > time.Second {
		t.Fatal("blocked writer blocked UI")
	}
	noCoreData(t, f)
	release()
	readyCorePane(t, a, tt, "c")
	old := wantCoreInput(t, f, "admitted-before")
	current := wantCoreInput(t, f, "heldmore")
	f.mu.Lock()
	oldWant, newWant := f.channels["a"], f.channels["c"]
	f.mu.Unlock()
	if old != oldWant || current != newWant {
		t.Fatal("writer recovery retargeted input")
	}
}

func TestCoreNavigationFailedCreationCannotReleaseOldPane(t *testing.T) {
	for _, failure := range []string{"run", "CAS", "later-intent"} {
		t.Run(failure, func(t *testing.T) {
			a, f, tt, release, _ := delayedCoreDestination(t, "creation")
			tt.Type("held")
			f.mu.Lock()
			method, kind := "doc.set", "conflict"
			if failure == "run" {
				method, kind = "terminal.run", "denied"
			}
			f.failOnce = map[string]string{method: kind}
			f.mu.Unlock()
			if failure == "later-intent" {
				coreAppAct(a, func() { a.ShowPane("b") })
				readyCorePane(t, a, tt, "b")
			}
			release()
			awaitCoreApp(t, a, func() bool { return a.coreOperationNote != "" })
			tt.Frame()
			if !notes(tt, navigationLost) {
				t.Fatal("failure erased retained-input loss")
			}
			if failure != "run" && !notes(tt, "Created t5 but did not add it") {
				t.Fatal("created orphan was not named")
			}
			noCoreData(t, f)
			if failure == "later-intent" {
				tt.Type("current")
				got := wantCoreInput(t, f, "current")
				f.mu.Lock()
				want := f.channels["b"]
				f.mu.Unlock()
				if got != want {
					t.Fatal("old failure retargeted new intent")
				}
			} else {
				tt.TypeKeyNative(0, ui.KeyX, "not old")
				tt.Key(0, ui.KeyEnter)
				noCoreData(t, f)
				if !a.coreBlocked {
					t.Fatal("failed creation opened old target")
				}
			}
		})
	}
}
func TestCoreNavigationCreationRejectsMissingOrExistingIdentity(t *testing.T) {
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified software VT required")
	}
	for _, address := range []string{"", "a"} {
		t.Run("address="+address, func(t *testing.T) {
			a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) { coreActivitySeed(f); r := f.terminals[address]; f.runResult = &r })
			tt := ui.NewTester(a.View, 1280, 800)
			readyCorePane(t, a, tt, "a")
			release, held := holdCoreMethod(t, f, "terminal.run")
			coreAppAct(a, func() { a.NewTab("w1") })
			select {
			case <-held:
			case <-time.After(time.Second):
				t.Fatal("Run missing")
			}
			tt.Frame()
			tt.Type("held")
			release()
			awaitCoreApp(t, a, func() bool { return a.coreOperationNote != "" })
			tt.Frame()
			if len(coreRequests(f, "doc.set")) != 0 {
				t.Fatal("invalid creation identity entered layout")
			}
			noCoreData(t, f)
			if !a.coreBlocked {
				t.Fatal("invalid creation opened old target")
			}
		})
	}
}

func TestCoreNavigationPendingKeyKeepsNativeCommitOwner(t *testing.T) {
	a, f, tt, n, release := pendingCoreNavigation(t)
	tt.KeyDown(ui.KeyX)
	release()
	awaitCorePaintWithoutOwnership(t, a, tt, "c")
	tt.Frame()
	if a.coreCapture != n || !tt.Focused("navigation-input") {
		t.Fatal("readiness replaced native owner between keyDown and text commit")
	}
	noCoreData(t, f)
	if !tt.CommitTextNative("x") {
		t.Fatal("native commit owner disappeared")
	}
	tt.KeyUp(ui.KeyX)
	readyCorePane(t, a, tt, "c")
	got := wantCoreInput(t, f, "x")
	f.mu.Lock()
	want := f.channels["c"]
	f.mu.Unlock()
	if got != want {
		t.Fatal("native commit reached wrong target")
	}
}

func blockedCoreUI(t *testing.T, payload string, fail bool) (*App, *coreAppFixture, *ui.Tester, *coreBlockedWrite, func()) {
	t.Helper()
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified software VT required")
	}
	entered, gate := make(chan struct{}), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	var block *coreBlockedWrite
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		coreActivitySeed(f)
		f.wrap = func(c net.Conn) net.Conn {
			block = &coreBlockedWrite{Conn: c, entered: entered, release: gate, payload: payload, fail: fail}
			return block
		}
	})
	t.Cleanup(release)
	tt := ui.NewTester(a.View, 1280, 800)
	readyCorePane(t, a, tt, "a")
	awaitCorePaintWithoutOwnership(t, a, tt, "b")
	return a, f, tt, block, release
}
func waitCoreWrite(t *testing.T, b *coreBlockedWrite) {
	t.Helper()
	select {
	case <-b.entered:
	case <-time.After(time.Second):
		t.Fatal("Core writer did not reach DATA barrier")
	}
}
func wantCorePaneInput(t *testing.T, f *coreAppFixture, address, text string) {
	t.Helper()
	got := wantCoreInput(t, f, text)
	f.mu.Lock()
	want := f.channels[address]
	f.mu.Unlock()
	if want == 0 || got != want {
		t.Fatalf("DATA channel=%d, want %s/%d", got, address, want)
	}
}

func TestCoreNavigationReadyFlushCannotReviveCanceledContext(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	var n *coreCapture
	coreAppAct(a, func() { n = a.beginCoreCapture("a", false) })
	a.coreCaptureInput(n, ui.InputEvent{Kind: ui.InputCompose, Text: "preedit"})
	a.coreCaptureInput(n, ui.InputEvent{Kind: ui.InputKeyDown, Key: ui.KeyEnter})
	coreAppAct(a, func() {
		n.cancel()
		n.composing = false
		if !a.flushCoreCapture(n) {
			t.Fatal("ready flush did not consume invalid context")
		}
	})
	noCoreData(t, f)
	if a.coreCapture != nil || !a.coreBlocked || n.events != nil || a.navigationNote != navigationLost {
		t.Fatal("canceled operation revived capture")
	}
	coreAppAct(a, func() { a.ShowPane("a") })
	readyCorePane(t, a, tt, "a")
	tt.Type("later")
	wantCorePaneInput(t, f, "a", "later")
}

func TestCoreCreationCaptureWaitsForOrderedProgramObservation(t *testing.T) {
	for _, action := range []string{"workspace", "tab", "split"} {
		t.Run(action, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			release, held := holdCoreMethod(t, f, "event.created")
			coreAppAct(a, func() {
				switch action {
				case "workspace":
					a.NewWorkspace()
				case "tab":
					a.NewTab("w1")
				default:
					a.Split("a", "right")
				}
			})
			tt.Frame()
			if !tt.TypeKeyNative(0, ui.KeyX, "x") {
				t.Fatal("creation lost first native character")
			}
			select {
			case <-held:
			case <-time.After(time.Second):
				t.Fatal("creation event barrier missing")
			}
			awaitCoreApp(t, a, func() bool { return a.coreState.Version == 1 && !a.corePending })
			n := a.coreCapture
			if n == nil || !n.awaitProgram || n.program != 1 || a.coreState.Programs["t5"] != 0 {
				t.Fatal("CAS-before-created canceled capture or fabricated observation")
			}
			for range 4 {
				tt.Frame()
			}
			f.mu.Lock()
			targetChannel := f.channels["t5"]
			f.mu.Unlock()
			if a.coreCapture != n || targetChannel != 0 {
				t.Fatal("unobserved creation attached or lost original bounded capture")
			}
			noCoreData(t, f)
			release()
			readyCorePane(t, a, tt, n.pane)
			wantCorePaneInput(t, f, "t5", "x")
			tt.Type("later")
			wantCorePaneInput(t, f, "t5", "later")
			noCoreData(t, f)
		})
	}
}
