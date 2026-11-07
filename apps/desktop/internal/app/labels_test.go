package app

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/vibest"
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

func recordSeen(t *testing.T) (string, func() []string) {
	return recordSeenCalls(t, 0)
}

func recordSeenCalls(t *testing.T, failFirst int) (string, func() []string) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "vibest-seen")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "vibest.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var mu sync.Mutex
	var got []string
	var n int
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				r := bufio.NewReader(conn)
				for {
					line, err := r.ReadBytes('\n')
					if err != nil {
						return
					}
					var req struct {
						ID     uint64
						Method string
						Params struct {
							ID   string  `json:"id"`
							Turn float64 `json:"turn"`
						}
						Headers [][2]string
					}
					if json.Unmarshal(line, &req) != nil || req.Method != "Session.Seen" {
						if req.ID != 0 {
							fmt.Fprintf(conn, "{\"jsonrpc\":\"2.0\",\"id\":%d,\"result\":null}\n", req.ID)
						}
						continue
					}
					repo := ""
					for _, h := range req.Headers {
						if h[0] == "vibest-repository" {
							repo = h[1]
						}
					}
					mu.Lock()
					n++
					fail := n <= failFirst
					got = append(got, req.Params.ID+" "+strconv.FormatFloat(req.Params.Turn, 'f', -1, 64)+" "+repo)
					mu.Unlock()
					if fail {
						fmt.Fprintf(conn, "{\"jsonrpc\":\"2.0\",\"id\":%d,\"error\":{\"_tag\":\"Cause\",\"code\":0,\"message\":\"down\",\"data\":[{\"_tag\":\"Fail\",\"error\":{\"_tag\":\"RuntimeUnreachable\",\"message\":\"down\"}}]}}\n", req.ID)
						return
					}
					fmt.Fprintf(conn, "{\"jsonrpc\":\"2.0\",\"id\":%d,\"result\":null}\n", req.ID)
				}
			}()
		}
	}()
	return path, func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := append([]string(nil), got...)
		slices.Sort(out)
		return out
	}
}

func awaitSeenCalls(t *testing.T, tt *ui.Tester, calls func() []string, want ...string) {
	t.Helper()
	slices.Sort(want)
	deadline := time.Now().Add(3 * time.Second)
	for {
		tt.Frame()
		got := calls()
		if slices.Equal(got, want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("seen calls %v, want %v", got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestSeenIsSentOncePerTurnForADrawnSession(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	path, calls := recordSeen(t)
	useVibest(a, path)
	turn := 1.0
	main := vibestSession("main", "lead", "p1", "idle", "a", nil, 1)
	main.Turn = &turn
	blank := vibestSession("blank", "blank", "p1", "idle", "b", nil, 2)
	hiddenTurn := 4.0
	hidden := vibestSession("hid", "hidden", "p1", "idle", "c", nil, 3)
	hidden.Turn = &hiddenTurn
	applyVibest(a, shippingSnapshot(main, blank, hidden))
	awaitSeenCalls(t, tt, calls, "main 1 /code/Shipping")
	for range 5 {
		tt.Frame()
	}
	if got := calls(); !slices.Equal(got, []string{"main 1 /code/Shipping"}) {
		t.Fatalf("repeated frames sent again: %v", got)
	}

	a.Focus(false)
	tt.SetFocused(false)
	tt.Frame()
	five := 5.0
	main.Turn = &five
	applyVibest(a, vibest.Event{Tag: "Session", Session: &main})
	for range 5 {
		tt.Frame()
		time.Sleep(10 * time.Millisecond)
	}
	if got := calls(); !slices.Equal(got, []string{"main 1 /code/Shipping"}) {
		t.Fatalf("unfocused window sent seen: %v", got)
	}
	a.Focus(true)
	tt.SetFocused(true)
	awaitSeenCalls(t, tt, calls, "main 1 /code/Shipping", "main 5 /code/Shipping")
	if got := seenWrites(f); len(got) != 0 {
		t.Fatalf("desktop wrote herdr.seen: %v", got)
	}
}

func TestSeenRetriesWhenTheCallFails(t *testing.T) {
	a, _, tt := coreActivityUI(t)
	path, calls := recordSeenCalls(t, 1)
	useVibest(a, path)
	turn := 1.0
	main := vibestSession("main", "lead", "p1", "idle", "a", nil, 1)
	main.Turn = &turn
	applyVibest(a, shippingSnapshot(main))
	awaitSeenCalls(t, tt, calls, "main 1 /code/Shipping", "main 1 /code/Shipping")
	for range 5 {
		tt.Frame()
	}
	if got := calls(); len(got) != 2 {
		t.Fatalf("retried after success: %v", got)
	}
}

func TestWatchStatusIsShownAndPinWritesTheSharedLabel(t *testing.T) {
	a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
		f.terminals["e"] = core.Terminal{Address: "e", State: "live", Turn: 3, Labels: map[string]string{"herdr.seen": "2"}}
		f.terminals["g"] = core.Terminal{Address: "g", State: "live", Turn: 3, Labels: map[string]string{"herdr.seen": "3", "herdr.pinned": "1"}}
	})
	snap := shippingSnapshot(
		vibestSession("main", "lead", "p1", "idle", "e", nil, 1),
		vibestSession("late", "pinned-one", "p1", "done", "g", nil, 2),
	)
	snap.Projects[0].Activity = "done"
	applyVibest(a, snap)
	tt.Frame()
	if _, done := tt.Find("session activity: done"); !done {
		t.Fatalf("project activity done is not shown: %v", tt.Texts())
	}
	openShipping(t, a, tt)
	if find(t, tt, "pinned-one").X >= find(t, tt, "lead").X {
		t.Fatal("the pinned session is not first")
	}
	if _, done := tt.Find("session activity: done"); !done {
		t.Fatal("a seen label cleared the status Watch reported")
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
	if got := seenWrites(f); len(got) != 0 {
		t.Fatalf("desktop wrote herdr.seen: %v", got)
	}
}
