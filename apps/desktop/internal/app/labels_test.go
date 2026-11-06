package app

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/core"
)

func seenWrites(f *coreAppFixture) []string {
	var out []string
	for _, p := range coreRequests(f, "terminal.label") {
		var req struct {
			Terminal string
			Labels   map[string]string
		}
		json.Unmarshal(p, &req)
		if v, ok := req.Labels["herdr.seen"]; ok {
			out = append(out, req.Terminal+"="+v)
		}
	}
	slices.Sort(out)
	return out
}

func awaitSeen(t *testing.T, a *App, tt *ui.Tester, f *coreAppFixture, want ...string) {
	t.Helper()
	slices.Sort(want)
	deadline := time.Now().Add(3 * time.Second)
	for {
		tt.Frame()
		got := seenWrites(f)
		if slices.Equal(got, want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("seen writes %v, want %v", got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func setRecord(f *coreAppFixture, kind, address string, change func(*core.Terminal)) {
	f.mu.Lock()
	r := f.terminals[address]
	f.mu.Unlock()
	change(&r)
	f.report(kind, r)
}

func TestSeenIsRaisedOncePerTurnForAgentsOnScreenWithTheWindowInFront(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	awaitSeen(t, a, tt, f, "a=1", "b=2")
	for range 5 {
		tt.Frame()
	}
	awaitSeen(t, a, tt, f, "a=1", "b=2")

	setRecord(f, "labels", "a", func(r *core.Terminal) { r.Labels = map[string]string{"herdr.seen": "0"} })
	for range 5 {
		tt.Frame()
		time.Sleep(10 * time.Millisecond)
	}
	awaitSeen(t, a, tt, f, "a=1", "b=2")

	a.Focus(false)
	tt.SetFocused(false)
	tt.Frame()
	setRecord(f, "turn", "a", func(r *core.Terminal) { r.Turn = 5 })
	for range 5 {
		tt.Frame()
		time.Sleep(10 * time.Millisecond)
	}
	awaitSeen(t, a, tt, f, "a=1", "b=2")

	a.Focus(true)
	tt.SetFocused(true)
	awaitSeen(t, a, tt, f, "a=1", "a=5", "b=2")
}

func TestPaneNotOnScreenIsNotSeen(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	awaitSeen(t, a, tt, f, "a=1", "b=2")
	for range 5 {
		tt.Frame()
		time.Sleep(10 * time.Millisecond)
	}
	if got := seenWrites(f); slices.ContainsFunc(got, func(s string) bool { return s[0] == 'c' || s[0] == 'd' }) {
		t.Fatalf("terminals in other tabs marked seen: %v", got)
	}
}

func TestDoneAndPinFollowTheSharedLabels(t *testing.T) {
	a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		f.terminals["e"] = core.Terminal{Address: "e", State: "live", Turn: 3, Labels: map[string]string{"herdr.seen": "2"}}
		f.terminals["g"] = core.Terminal{Address: "g", State: "live", Turn: 3, Labels: map[string]string{"herdr.seen": "3", "herdr.pinned": "1"}}
	})
	applyVibest(a, shippingSnapshot(
		vibestSession("main", "lead", "p1", "idle", "e", nil, 1),
		vibestSession("late", "pinned-one", "p1", "done", "g", nil, 2),
	))
	tt.Frame()
	if _, done := tt.Find("session activity: done"); !done {
		t.Fatalf("turn 3 over seen 2 is not done: %v", tt.Texts())
	}
	openShipping(t, a, tt)
	if find(t, tt, "pinned-one").X >= find(t, tt, "lead").X {
		t.Fatal("the pinned session is not first")
	}
	if got := a.sessionStatus(vibestSession("late", "pinned-one", "p1", "done", "g", nil, 2)); got != "idle" {
		t.Fatalf("a seen turn shows %q, want idle", got)
	}
	if err := tt.RightClick("session: lead"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Pin"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool {
		for _, p := range coreRequests(f, "terminal.label") {
			var req struct {
				Terminal string
				Labels   map[string]string
			}
			json.Unmarshal(p, &req)
			if req.Terminal == "e" && req.Labels["herdr.pinned"] == "1" {
				return true
			}
		}
		return false
	})
}
