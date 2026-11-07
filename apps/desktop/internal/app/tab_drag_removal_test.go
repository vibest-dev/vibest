package app

import (
	"testing"
	"vibest-desktop/internal/core"
)

func TestTabDragPermanentSourceRemovalAllowsFreshGesture(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		a, f, update, tt := tabDragFixture(t, style)
		startTabGesture(t, a, tt, true)
		update(func(l *core.Layout) { l.Workspaces[0].Tabs = l.Workspaces[0].Tabs[1:] })
		tt.Frame()
		tt.Release(500, 500)
		tt.Frame()
		if len(coreRequests(f, "doc.set")) != 0 {
			t.Fatal("removed source dispatched")
		}
		finishTabGesture(t, tt, "move", "t2")
		wantTabOrder(t, a, tt, "t3", "t2", "t4")
		if a.coreSelection.Tab != "t2" || len(coreRequests(f, "doc.set")) != 1 {
			t.Fatal("fresh gesture failed after removal")
		}
		noCoreData(t, f)
	}
}
