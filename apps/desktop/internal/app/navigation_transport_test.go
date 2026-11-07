package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
	"time"
)

func TestNavigationBlockedWriterDoesNotBlockUIOrHealthyEndpoint(t *testing.T) {
	_, f, tt, b, release := blockedCoreUI(t, "x", false)
	_, healthy, other := coreActivityUI(t)
	if !tt.CommitTextNative("x") {
		t.Fatal("native context inactive")
	}
	waitCoreWrite(t, b)
	done := make(chan struct{})
	go func() { tt.Frame(); tt.KeyUnframed(0, ui.KeyEnter); other.TypeKeyNative(0, ui.KeyY, "y"); close(done) }()
	select {
	case <-done:
	case <-time.After(400 * time.Millisecond):
		release()
		<-done
		t.Fatal("UI blocked behind Core writer")
	}
	wantCorePaneInput(t, healthy, "a", "y")
	noCoreData(t, f)
	release()
	wantCorePaneInput(t, f, "a", "x")
	wantCorePaneInput(t, f, "a", "\r")
	noCoreData(t, f)
}
