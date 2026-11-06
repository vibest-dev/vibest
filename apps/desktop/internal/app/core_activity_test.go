package app

import (
	"encoding/json"
	"github.com/egoist/mygo/ui"
	"net"
	"os"
	"reflect"
	"testing"
	"time"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/coreview"
)

func coreActivitySeed(f *coreAppFixture) {
	pane := func(id string) *core.Split {
		p := core.NewPane(core.TerminalRef{CoreID: "app-fixture", Address: id})
		p.ID = id
		return &core.Split{Pane: &p}
	}
	f.layout = core.Layout{Schema: 1, CoreID: "app-fixture", Workspaces: []core.Workspace{
		{ID: "w1", Label: "Repo", CWD: "/inert/repo", Tabs: []core.Tab{{ID: "t1", Label: "Build", Root: &core.Split{Axis: "x", Ratio: .5, First: pane("a"), Second: pane("b")}}, {ID: "t2", Label: "Review", Root: pane("c")}}},
		{ID: "w2", Label: "Other", CWD: "/inert/other", Tabs: []core.Tab{{ID: "t3", Label: "Other", Root: pane("d")}}},
	}}
	for i, id := range []string{"a", "b", "c", "d"} {
		f.terminals[id] = core.Terminal{Address: id, State: "live", Cols: 80, Rows: 24, Reported: true, Status: &core.Status{State: "done"}, Turn: uint64(i + 1)}
	}
}
func TestCoreActivityAggregatePriorities(t *testing.T) {
	for _, tc := range []struct {
		name                string
		records             []core.Terminal
		status, description string
	}{
		{"unknown", []core.Terminal{{Status: &core.Status{State: "working"}, Turn: 99}, {Reported: true}}, "", "Activity unknown"},
		{"idle and blocked", []core.Terminal{{Reported: true, Status: &core.Status{State: "blocked"}}, {Reported: true, Status: &core.Status{State: "idle"}}}, "", "Needs attention (reported)"},
		{"error and idle", []core.Terminal{{Reported: true, Status: &core.Status{State: "error"}}, {Reported: true, Status: &core.Status{State: "idle"}}}, "", "Error (reported)"},
		{"both attention states", []core.Terminal{{Reported: true, Status: &core.Status{State: "blocked"}}, {Reported: true, Status: &core.Status{State: "error"}}}, "", "Error (reported)"},
		{"working over completion", []core.Terminal{{Reported: true, Status: &core.Status{State: "done"}, Turn: 1}, {Reported: true, Status: &core.Status{State: "working"}}, {Status: &core.Status{State: "blocked"}}}, "working", "Working (reported)"},
		{"completed then idle", []core.Terminal{{Reported: true, Status: &core.Status{State: "idle"}, Turn: 2}, {Reported: true, Status: &core.Status{State: "blocked"}}}, "done", "Completed, not visited (reported)"},
		{"done without turn", []core.Terminal{{Reported: true, Status: &core.Status{State: "done"}}}, "", "Completed (reported)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, _ := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
				coreActivitySeed(f)
				for i, id := range []string{"a", "b", "c", "d"} {
					r := core.Terminal{}
					if i < len(tc.records) {
						r = tc.records[i]
					}
					r.Address = id
					f.terminals[id] = r
				}
			})
			a.mu.Lock()
			defer a.mu.Unlock()
			for range 100 {
				status, description := a.machine.activity(activityScope{workspace: "w1"})
				if status != tc.status || description != tc.description {
					t.Fatalf("got %q/%q want %q/%q", status, description, tc.status, tc.description)
				}
			}
		})
	}
}

func reportActivity(t *testing.T, a *App, f *coreAppFixture, id, state string, turn uint64, reported bool) {
	t.Helper()
	f.mu.Lock()
	record := f.terminals[id]
	f.mu.Unlock()
	record.Reported, record.Status, record.Turn = reported, &core.Status{State: state}, turn
	f.report("status", record)
	awaitCoreApp(t, a, func() bool {
		got := a.coreState.Terminals[id]
		return got.Reported == reported && got.Turn == turn && got.Activity() == record.Activity()
	})
}
func wantCoreSeen(t *testing.T, a *App, want map[string]uint64) {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	got := map[string]uint64{}
	for _, m := range a.machines {
		for ref, turn := range m.coreSeen {
			got[ref.Address] = turn
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("acknowledgments=%v, want %v", got, want)
	}
}
func reconnectCoreApp(t *testing.T, a *App, f *coreAppFixture, prepare func(*coreAppFixture)) *coreAppFixture {
	t.Helper()
	a.mu.Lock()
	old := a.coreSession
	a.mu.Unlock()
	left, right := net.Pipe()
	next := &coreAppFixture{peer: right, reconnect: f.reconnect, seq: 1, terminals: map[string]core.Terminal{}, inputs: make(chan coreAppFrame, 32)}
	prepare(next)
	go next.serve()
	t.Cleanup(func() { left.Close(); right.Close() })
	f.reconnect <- left
	f.peer.Close()
	awaitCoreApp(t, a, func() bool { return a.coreState.Connected && a.coreSession != nil && a.coreSession != old })
	return next
}

func coreActivityUI(t *testing.T) (*App, *coreAppFixture, *ui.Tester) {
	return coreActivityUIWith(t, nil)
}
func coreActivityUIWith(t *testing.T, change func(*coreAppFixture)) (*App, *coreAppFixture, *ui.Tester) {
	t.Helper()
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified MYGO_GHOSTTY_VT required for Core software UI fixtures")
	}
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		coreActivitySeed(f)
		if change != nil {
			change(f)
		}
	})
	tt := ui.NewTester(a.View, 1280, 800)
	readyCorePane(t, a, tt, "a")
	return a, f, tt
}
func readyCorePane(t *testing.T, a *App, tt *ui.Tester, id string) *coreview.Terminal {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		tt.Frame()
		a.mu.Lock()
		v := a.coreViews[id]
		ready := v != nil && v.InputReady() && a.coreCapture == nil && !a.coreBlocked
		note := a.navigationNote
		a.mu.Unlock()
		if ready {
			return v
		}
		if time.Now().After(deadline) {
			a.mu.Lock()
			t.Logf("selection=%+v pending=%v blocked=%v capture=%+v fence=%+v returnFocus=%v selected=%p viewer=%p", a.coreSelection, a.corePending, a.coreBlocked, a.coreCapture, a.coreFence, a.returnFocus, a.coreSelected, v)
			a.mu.Unlock()
			t.Logf("focused terminal=%v navigation=%v control=%v", tt.Focused("terminal/"+id), tt.Focused("navigation-input"), tt.Focused("machine: Local"))
			t.Fatalf("Core pane %s not ready: %s", id, note)
		}
		time.Sleep(time.Millisecond)
	}
}
func wantCoreInput(t *testing.T, f *coreAppFixture, text string) uint32 {
	t.Helper()
	select {
	case p := <-f.inputs:
		if string(p.body) != text {
			t.Fatalf("input=%q want %q", p.body, text)
		}
		return p.channel
	case <-time.After(time.Second):
		t.Fatal("missing Core input: " + text)
		return 0
	}
}
func noLegacyNavigation(t *testing.T, f *coreAppFixture) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, method := range f.methods {
		switch method {
		case "workspace.focus", "tab.focus", "pane.focus", "pane.focus_direction":
			t.Fatal("legacy navigation RPC: " + method)
		}
	}
}

func wantCoreViewerControls(t *testing.T, f *coreAppFixture, channel uint32) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		focus, facts := false, false
		f.mu.Lock()
		for _, c := range f.controls {
			if c.channel != channel {
				continue
			}
			if c.kind == 4 && len(c.body) == 1 {
				focus = c.body[0] == 1
			}
			if c.kind == 5 {
				var display core.Display
				if json.Unmarshal(c.body, &display) == nil && display.Cell != nil && display.Cell[0] > 0 && display.Cell[1] > 0 {
					facts = true
				}
			}
		}
		f.mu.Unlock()
		if focus && facts {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("channel %d missing focus/FACTS: %v/%v", channel, focus, facts)
		}
		time.Sleep(time.Millisecond)
	}
}
func wantCoreCellMetrics(t *testing.T, f *coreAppFixture, channel uint32, width, height int) {
	t.Helper()
	wantCoreViewerControls(t, f, channel)
	deadline := time.Now().Add(time.Second)
	for {
		var latest core.Display
		f.mu.Lock()
		for _, frame := range f.controls {
			if frame.channel == channel && frame.kind == 5 {
				_ = json.Unmarshal(frame.body, &latest)
			}
		}
		f.mu.Unlock()
		if latest.Cell != nil && latest.Cell[0] == uint32(width) && latest.Cell[1] == uint32(height) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("latest Core cell FACTS=%v want %dx%d", latest.Cell, width, height)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestCoreProgramReplacementDropsRendererAndCompletionHistory(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	old := readyCorePane(t, a, tt, "a")
	capture, ok := a.coreKeyboard.CaptureFor(old.Viewer)
	if !ok {
		t.Fatal("no original capture")
	}
	coreAppAct(a, func() { a.ShowPane("a") })
	wantCoreSeen(t, a, map[string]uint64{"a": 1})
	tt.Type("original")
	before := wantCoreInput(t, f, "original")
	wantCoreViewerControls(t, f, before)
	f.mu.Lock()
	record := f.terminals["a"]
	f.mu.Unlock()
	f.report("restarted", record)
	awaitCoreApp(t, a, func() bool { return a.coreState.Programs["a"] == 1 })
	replacement := readyCorePane(t, a, tt, "a")
	if replacement == old || replacement.VT == old.VT || capture.Valid() {
		t.Fatal("replacement retained old renderer/input capture")
	}
	wantCoreSeen(t, a, map[string]uint64{})
	tt.Type("replacement")
	after := wantCoreInput(t, f, "replacement")
	if before == after {
		t.Fatal("replacement reused retired channel")
	}
	wantCoreViewerControls(t, f, after)
}
