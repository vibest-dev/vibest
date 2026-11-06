package app

import "testing"

func TestTabDragBlurRecoversFirstGesture(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		for _, owner := range []string{"terminal/p-t1", "Terminals"} {
			t.Run(style+owner, func(t *testing.T) {
				a, f, _, tt := tabDragFixture(t, style)
				if owner != "terminal/p-t1" {
					focusNavigationControl(t, tt, owner)
				}
				v := a.coreViews["p-t1"]
				startTabGesture(t, a, tt, true)
				d := a.activeTabDrag
				a.Focus(false)
				if !d.canceled {
					t.Fatal("blur did not immediately cancel intent")
				}
				tt.SetFocused(false)
				tt.Frame()
				tt.SetFocused(true)
				a.Focus(true)
				tt.Frame()
				if a.activeTabDrag != nil {
					t.Fatal("blur left held source")
				}
				if owner == "terminal/p-t1" {
					tt.Compose("字", 1)
					tt.Frame()
					if tabPreedit(t, a) != "字" {
						t.Fatal("refocused composition unavailable")
					}
				}
				finishTabGesture(t, tt, "move", "t2")
				wantTabOrder(t, a, tt, "t1", "t3", "t2", "t4")
				if !d.canceled || d.tabID != "t1" || !tt.Focused(owner) || a.coreViews["p-t1"] != v {
					t.Fatal("recovery rebound original source/owner")
				}
				if owner == "terminal/p-t1" {
					if tabPreedit(t, a) != "字" {
						t.Fatal("recovered drag cleared preedit")
					}
					tt.CommitTextNative("字")
					wantCorePaneInput(t, f, "p-t1", "字")
				}
				noCoreData(t, f)
			})
		}
	}
}
