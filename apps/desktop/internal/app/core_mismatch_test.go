package app

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/core"
)

func TestCoreVersionMismatchWaitsForRetry(t *testing.T) {
	a := NewApp("/inert/never-dialed.sock")
	var dials atomic.Int32
	a.dialCore = func(context.Context, string) (*core.Client, error) {
		dials.Add(1)
		return nil, &core.Mismatch{Version: "0.2.0", Generation: core.PinnedGeneration}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	tt := ui.NewTester(a.View, 1280, 800)
	awaitDials := func(want int32) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for dials.Load() < want {
			if time.Now().After(deadline) {
				t.Fatalf("dials=%d, want %d", dials.Load(), want)
			}
			time.Sleep(time.Millisecond)
		}
		awaitCoreApp(t, a, func() bool { return a.coreMismatch && strings.Contains(a.err, "0.2.0") })
	}
	awaitDials(1)
	time.Sleep(time.Second)
	if n := dials.Load(); n != 1 {
		t.Fatalf("a mismatch was retried %d times without Retry", n-1)
	}
	tt.Frame()
	if _, ok := tt.Find("herdr-core version mismatch"); !ok {
		t.Fatalf("no mismatch title: %v", tt.Texts())
	}
	if err := tt.Click("Retry"); err != nil {
		t.Fatal(err)
	}
	awaitDials(2)
	time.Sleep(500 * time.Millisecond)
	if n := dials.Load(); n != 2 {
		t.Fatalf("Retry reconnected %d times, want once", n-1)
	}
}
