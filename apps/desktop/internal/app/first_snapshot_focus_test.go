package app

import (
	"github.com/egoist/mygo/ui"
	"strings"
	"sync"
	"testing"
	"time"
)

func holdCoreMethod(t *testing.T, f *coreAppFixture, key string) (func(), <-chan string) {
	t.Helper()
	gate := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	t.Cleanup(release)
	f.mu.Lock()
	if f.hold == nil {
		f.hold = map[string]<-chan struct{}{}
	}
	f.hold[key] = gate
	f.held = make(chan string, 4)
	held := f.held
	f.mu.Unlock()
	return release, held
}
func delayedCoreDestination(t *testing.T, origin string) (*App, *coreAppFixture, *ui.Tester, func(), func() string) {
	t.Helper()
	a, f, tt := coreActivityUI(t)
	key := "terminal.attach c"
	if origin == "creation" {
		key = "terminal.run"
	}
	release, held := holdCoreMethod(t, f, key)
	coreAppAct(a, func() {
		if origin == "creation" {
			a.NewWorkspace()
		} else {
			a.SelectTab("t2")
		}
	})
	tt.Frame()
	select {
	case got := <-held:
		if got != key {
			t.Fatalf("wrong barrier: %s", got)
		}
	case <-time.After(time.Second):
		t.Fatal("request never reached barrier")
	}
	target := func() string {
		if origin == "creation" {
			awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces) == 3 })
			a.mu.Lock()
			defer a.mu.Unlock()
			return a.coreState.Layout.Workspaces[2].Tabs[0].Root.Pane.ID
		}
		return "c"
	}
	return a, f, tt, release, target
}
func awaitCorePaintWithoutOwnership(t *testing.T, a *App, tt *ui.Tester, id string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		tt.Frame()
		a.mu.Lock()
		v := a.coreViews[id]
		parsed := v != nil && v.Fitted() && strings.Contains(v.VT.Text(), "Core fixture ready")
		a.mu.Unlock()
		if parsed {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("delayed viewer did not arrive")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestFirstSnapshotPreservesLaterModalChoice(t *testing.T) {
	for _, origin := range []string{"attach", "creation"} {
		t.Run(origin, func(t *testing.T) {
			a, f, tt, release, target := delayedCoreDestination(t, origin)
			ran := false
			coreAppAct(a, func() { a.confirmInWindow("Later choice", "", "Close", func() { ran = true }, nil) })
			tt.Frame()
			tt.Key(0, ui.KeyTab)
			if !tt.Focused("Close") {
				t.Fatal("could not select modal choice")
			}
			release()
			id := target()
			awaitCorePaintWithoutOwnership(t, a, tt, id)
			if !tt.Focused("Close") || a.returnFocus {
				t.Fatal("late model/attach stole later modal choice")
			}
			tt.TypeKey(0, ui.KeyX, "x")
			tt.Key(ui.Cmd, ui.KeyK)
			if !tt.Focused("Close") {
				t.Fatal("modal lost keyboard ownership")
			}
			select {
			case p := <-f.inputs:
				t.Fatalf("modal leaked %q", p.body)
			default:
			}
			tt.Key(0, ui.KeyEnter)
			readyCorePane(t, a, tt, id)
			if !ran {
				t.Fatal("preserved modal choice not activated")
			}
		})
	}
}
func TestFirstSnapshotConsumesNavigationFocusOnce(t *testing.T) {
	for _, origin := range []string{"attach", "creation"} {
		t.Run(origin, func(t *testing.T) {
			a, f, tt, release, target := delayedCoreDestination(t, origin)
			release()
			id := target()
			readyCorePane(t, a, tt, id)
			if a.returnFocus || !tt.Focused("terminal/"+id) {
				t.Fatal("first fitted view did not consume handoff")
			}
			tt.Type("first")
			wantCoreInput(t, f, "first")
			focusNavigationControl(t, tt, "Terminals")
			reportActivity(t, a, f, "a", "working", 1, true)
			tt.Frame()
			if a.returnFocus || !tt.Focused("Terminals") {
				t.Fatal("later update repeated focus handoff")
			}
		})
	}
}
func TestDelayedCreationCannotOverrideLaterNavigation(t *testing.T) {
	a, f, tt, release, target := delayedCoreDestination(t, "creation")
	coreAppAct(a, func() { a.ShowPane("b") })
	release()
	_ = target()
	readyCorePane(t, a, tt, "b")
	tt.Type("later choice")
	got := wantCoreInput(t, f, "later choice")
	f.mu.Lock()
	want := f.channels["b"]
	f.mu.Unlock()
	if got != want {
		t.Fatal("delayed creation overrode newer navigation")
	}
}
