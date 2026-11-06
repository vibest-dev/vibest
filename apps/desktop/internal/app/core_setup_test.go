package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/core"
)

func TestTheWindowSaysWhatHerdrCoreNeeds(t *testing.T) {
	for _, tc := range []struct {
		name  string
		err   error
		texts []string
	}{
		{"hc missing", core.ErrNoCore, []string{"Vibest needs herdr-core", "Vibest couldn't find it on this computer", "Install it, then Retry: " + core.CoreInstallCommand, "Retry"}},
		{"core did not start", &core.StartError{Reason: "error: core did not start within 5 s"}, []string{"Not connected to herdr-core", "herdr-core is there but didn't start: error: core did not start within 5 s", "Reconnect"}},
		{"core too old", &core.Mismatch{Version: "0.1.9", Generation: core.PinnedGeneration, Missing: []string{"doc.set"}}, []string{"Vibest needs a newer herdr-core", "herdr-core 0.1.9 cannot do everything this app needs (doc.set)", "Update it, then Retry: hc update", "Retry"}},
		{"core too new", &core.Mismatch{Version: "0.3.0", Generation: core.PinnedGeneration + 1}, []string{"This Vibest is older than your herdr-core", "Update Vibest; your terminals keep running.", "Retry"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := NewApp("/inert/never-dialed.sock")
			a.SetCoreDialer(func(context.Context, string) (*core.Client, error) { return nil, tc.err })
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() { defer close(done); a.Run(ctx) }()
			t.Cleanup(func() { cancel(); <-done })
			tt := ui.NewTester(a.View, 1280, 800)
			deadline := time.Now().Add(3 * time.Second)
			for {
				tt.Frame()
				missing := ""
				shown := strings.Join(tt.Texts(), "\n")
				for _, want := range tc.texts {
					if !strings.Contains(shown, want) {
						missing = want
					}
				}
				if missing == "" {
					return
				}
				if time.Now().After(deadline) {
					t.Fatalf("no %q in %v", missing, tt.Texts())
				}
				time.Sleep(5 * time.Millisecond)
			}
		})
	}
}
