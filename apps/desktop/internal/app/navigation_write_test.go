package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
)

func TestNavigationCommittedWritesKeepCapturedTargetsAndFIFO(t *testing.T) {
	a, f, tt, b, release := blockedCoreUI(t, "held", false)
	tt.Type("held")
	waitCoreWrite(t, b)
	coreAppAct(a, func() { a.ShowPane("b") })
	readyCorePane(t, a, tt, "b")
	tt.Key(0, ui.KeyEnter)
	noCoreData(t, f)
	release()
	wantCorePaneInput(t, f, "a", "held")
	wantCorePaneInput(t, f, "b", "\r")
	noCoreData(t, f)
}
