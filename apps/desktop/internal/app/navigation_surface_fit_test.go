package app

import (
	"github.com/egoist/mygo/ui"
	"strings"
	"testing"
)

func TestNavigationPendingCursorSurfaceCannotDrain(t *testing.T) {
	a, f, tt, n, release := pendingCoreNavigation(t)
	tt.Type("x")
	tt.Key(0, ui.KeyEnter)
	tt.SetSize(80, 60)
	tt.Frame()
	release()
	awaitCoreApp(t, a, func() bool { return a.coreViews["c"] != nil })
	v := a.coreViews["c"]
	navigationWait(t, func() bool { tt.Frame(); return strings.Contains(v.VT.Text(), "Core fixture ready") })
	if v.Fitted() || v.InputReady() || a.coreCapture != n || n.count != 2 {
		t.Fatal("parsed output or cursor bypassed clipped paint")
	}
	noCoreData(t, f)
	tt.SetSize(1280, 800)
	readyCorePane(t, a, tt, "c")
	wantCorePaneInput(t, f, "c", "x\r")
	noCoreData(t, f)
}
