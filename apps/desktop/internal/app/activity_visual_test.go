package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
	"vibest-desktop/internal/chrome"
)

func TestActivityVisuals(t *testing.T) {
	for _, name := range []string{"Paper", "Nord"} {
		t.Run(name, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			reportActivity(t, a, f, "a", "working", 1, true)
			reportActivity(t, a, f, "d", "blocked", 0, true)
			th, _ := chrome.Builtin(name)
			coreAppAct(a, func() { a.themes.light, a.themes.dark = th, th })
			tt.SetSize(760, 420)
			tt.SetTitleBar(ui.TitleBar{Height: 36, Left: 78})
			tt.SetDark(th.Dark)
			shot(t, tt, "activity-"+name)
		})
	}
}
