package app

import "testing"

func TestTabDragInvalidatedPressDoesNotActivate(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		for _, change := range []string{"program", "workspace", "source-removal", "reference"} {
			a, f, update, tt := tabDragFixture(t, style)
			src := find(t, tt, "tab/t1")
			startTabGesture(t, a, tt, false)
			restore := invalidateCoreTab(t, a, f, tt, update, change)
			restore()
			tt.Frame()
			tt.Release(src.X+20, src.Y+14)
			tt.Frame()
			if len(coreRequests(f, "doc.set")) != 0 || a.coreCapture != nil {
				t.Fatal("invalidated press activated replacement")
			}
			noCoreData(t, f)
		}
	}
}
