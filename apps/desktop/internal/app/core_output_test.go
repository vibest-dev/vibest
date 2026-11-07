package app

import (
	"bytes"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibest-desktop/internal/coreview"
)

func TestCoreOutputFramesFollowShownPanes(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	first := readyCorePane(t, a, tt, "a")
	coreAppAct(a, func() { a.ShowPane("b") })
	split := readyCorePane(t, a, tt, "b")
	settle := func() {
		t.Helper()
		for range 10 {
			tt.Frame()
			time.Sleep(5 * time.Millisecond)
		}
		if tt.FramePending() {
			t.Fatal("fixture did not settle")
		}
	}
	check := func(v *coreview.Terminal, output string, want bool) {
		t.Helper()
		settle()
		v.VT.Feed([]byte(output))
		if got := tt.FramePending(); got != want {
			t.Fatalf("output %q requested frame=%v, want %v", output, got, want)
		}
	}
	check(first, "\rvisible unfocused split", true)
	check(split, "\rvisible focused split", true)
	coreAppAct(a, func() { a.SelectTab("t2") })
	other := readyCorePane(t, a, tt, "c")
	check(first, "\rhidden tab", false)
	check(split, "\rhidden split", false)
	first.VT.Feed([]byte("\x1b[6n"))
	select {
	case reply := <-f.inputs:
		if !strings.HasPrefix(string(reply.body), "\x1b[") || !strings.HasSuffix(string(reply.body), "R") {
			t.Fatalf("hidden automatic reply = %q", reply.body)
		}
	case <-time.After(time.Second):
		t.Fatal("hidden terminal lost its automatic reply")
	}
	check(other, "\x1b]2;identical title\x07", false)
	for range 100 {
		other.VT.Feed([]byte("\x1b]2;identical title\x07"))
	}
	if tt.FramePending() {
		t.Fatal("identical title loop requested a frame")
	}
	coreAppAct(a, func() { a.ShowPane("a") })
	readyCorePane(t, a, tt, "a")
	check(first, "\rvisible again", true)
	coreAppAct(a, func() { a.ZoomPane("a") })
	readyCorePane(t, a, tt, "a")
	check(split, "\rhidden by zoom", false)
	check(first, "\rzoomed pane", true)
	settle()
	before := bytes.Clone(tt.Image().Pix)
	first.VT.Feed([]byte("\rtyped echo"))
	if !tt.FramePending() {
		t.Fatal("echo was delayed")
	}
	tt.Advance(20 * time.Millisecond)
	if bytes.Equal(before, tt.Image().Pix) {
		t.Fatal("requested echo frame did not draw changed pixels")
	}
}

func TestCoreOutputIdenticalTitleEventsDoNotRequestFrames(t *testing.T) {
	var frames atomic.Int64
	a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		f.invalidate = func() { frames.Add(1) }
	})
	settle := func() {
		for range 10 {
			tt.Frame()
			time.Sleep(5 * time.Millisecond)
		}
		frames.Store(0)
	}
	f.mu.Lock()
	record := f.terminals["a"]
	f.mu.Unlock()
	record.Title = "new title"
	settle()
	f.report("title", record)
	awaitCoreApp(t, a, func() bool { return a.coreState.Terminals["a"].Title == record.Title && frames.Load() > 0 })
	settle()
	for range 20 {
		f.report("title", record)
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if got := frames.Load(); got != 0 {
		t.Fatalf("identical Core title events requested %d frames", got)
	}
	coreAppAct(a, func() { a.SelectTab("t2") })
	readyCorePane(t, a, tt, "c")
	settle()
	record.Title = "hidden title changed"
	f.report("title", record)
	awaitCoreApp(t, a, func() bool { return a.coreState.Terminals["a"].Title == record.Title && frames.Load() > 0 })
	settle()
	reportActivity(t, a, f, "a", "working", 20, true)
	awaitCoreApp(t, a, func() bool { return frames.Load() > 0 })
	a.mu.Lock()
	status, _ := a.machine.activity(activityScope{workspace: "w1"})
	a.mu.Unlock()
	if status != "working" {
		t.Fatalf("hidden terminal sidebar status=%q", status)
	}
}

func TestCoreOutputInputModeChangeUpdatesVisibleReadiness(t *testing.T) {
	a, _, tt := coreActivityUI(t)
	view := readyCorePane(t, a, tt, "a")
	for range 10 {
		tt.Frame()
		time.Sleep(5 * time.Millisecond)
	}
	if tt.FramePending() {
		t.Fatal("fixture did not settle")
	}
	view.VT.Feed([]byte("\x1b[?9001h"))
	if view.InputError() == nil {
		t.Fatal("unsupported input mode was not parsed")
	}
	if !tt.FramePending() {
		t.Fatal("changed input-readiness notice did not request a frame")
	}
}
