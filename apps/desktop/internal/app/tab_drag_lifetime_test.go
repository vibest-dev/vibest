package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
	"time"
	"vibest-desktop/internal/core"
)

func TestTabDragDefersStructuralPresentation(t *testing.T) {
	for _, from := range []string{paneCompact, paneComfortable} {
		a, f, _, tt := tabDragFixture(t, from)
		startTabGesture(t, a, tt, true)
		to := paneCompact
		if from == paneCompact {
			to = paneComfortable
		}
		coreAppAct(a, func() { a.themes.settings.PaneStyle = to; a.sidebarVisible = false })
		tt.Frame()
		tt.Advance(time.Second)
		if a.comfortable() != (from == paneComfortable) || a.sideAt != 1 {
			t.Fatal("held drag source reparented")
		}
		tt.Release(500, 500)
		tt.Frame()
		tt.Advance(time.Second)
		if a.activeTabDrag != nil || a.comfortable() != (to == paneComfortable) || a.sideAt != 0 {
			t.Fatal("presentation stayed held")
		}
		finishTabGesture(t, tt, "move", "t2")
		wantTabOrder(t, a, tt, "t1", "t3", "t2", "t4")
		tabDragOnly(t, a, f, 1)
	}
}
func TestTabDragPendingEscapeKeepsTerminalPreedit(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		a, f, _, tt := tabDragFixture(t, style)
		tt.Compose("字", 1)
		tt.Frame()
		s := find(t, tt, "tab/t2")
		tt.PressUnframed(s.X+20, s.Y+14)
		tt.KeyUnframed(0, ui.KeyEscape)
		tt.ReleaseUnframed(s.X+20, s.Y+14)
		tt.Frame()
		if a.activeTabDrag != nil || !tt.Focused("terminal/p-t1") || tabPreedit(t, a) != "字" {
			t.Fatal("pending Escape stole composition")
		}
		tabDragOnly(t, a, f, 0)
		tt.Key(0, ui.KeyEscape)
		wantCorePaneInput(t, f, "p-t1", "\x1b")
		noCoreData(t, f)
	}
}
func TestTabDragPendingEscapeKeepsControlOwner(t *testing.T) {
	a, f, _, tt := tabDragFixture(t, paneComfortable)
	focusNavigationControl(t, tt, "machine: Local")
	s := find(t, tt, "tab/t2")
	tt.Press(s.X+20, s.Y+14)
	tt.KeyUnframed(0, ui.KeyEscape)
	tt.ReleaseUnframed(s.X+20, s.Y+14)
	tt.Frame()
	if !tt.Focused("machine: Local") || a.activeTabDrag != nil {
		t.Fatal("cancel displaced control owner")
	}
	tabDragOnly(t, a, f, 0)
}
func TestTabDragOutsideReleaseKeepsKeyboardActivation(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		a, f, update, tt := tabDragFixture(t, style)
		focusNavigationControl(t, tt, "tab/t2")
		s := find(t, tt, "tab/t2")
		tt.Press(s.X+1, s.Y+14)
		update(func(l *core.Layout) { l.Pane("p-t2").Terminal.Address = "replacement" })
		tt.Frame()
		tt.ReleaseUnframed(s.X-1, s.Y+14)
		tt.KeyUnframed(0, ui.KeyEnter)
		tt.Frame()
		if a.coreSelection.Tab != "t2" {
			t.Fatal("outside release vetoed new keyboard activation")
		}
		noCoreData(t, f)
	}
}
