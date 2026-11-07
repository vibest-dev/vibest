package chrome

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestGlassKeepsSurfacesTranslucentAndGreysAsInkAlphas(t *testing.T) {
	for _, name := range Builtins {
		th, _ := Builtin(name)
		before := *th
		g := th.Glass()
		if g == th || g.Glass() != g || th.Glass() != g {
			t.Fatalf("%s: Glass is not one stable theme of its own", name)
		}
		ink := th.Foreground
		alpha := func(a float32) uint8 { return ink.Alpha(a).A }
		checks := []struct {
			role string
			got  ui.Color
			want ui.Color
		}{
			{"Background", g.Background, th.Background.Alpha(GlassShell)},
			{"Sidebar", g.Sidebar, th.Sidebar.Alpha(GlassShell)},
			{"TabBar", g.TabBar, th.TabBar.Alpha(GlassShell)},
			{"pane", g.Container.Background, th.Background.Alpha(GlassPane)},
			{"Border", g.Border, ink.Alpha(inkBorder)},
			{"Divider", g.Divider, ink.Alpha(inkDivider)},
			{"row hover", g.Row.Hover.Background, ink.Alpha(inkHover)},
			{"row selected", g.Row.Active.Background, ink.Alpha(inkSelected)},
			{"row selected text", g.Row.Active.Foreground, ink},
			{"tab base text", g.Tab.Base.Foreground, ink.Alpha(inkStrong)},
			{"surface", g.Surface, th.Surface},
			{"accent", g.Accent, th.Accent},
			{"working", g.Working, th.Working},
		}
		for _, c := range checks {
			if c.got != c.want {
				t.Errorf("%s %s: %v, want %v", name, c.role, c.got, c.want)
			}
		}
		if g.Background.A != 207 || g.Container.Background.A != 71 || g.Row.Active.Background.A != alpha(inkSelected) {
			t.Errorf("%s: alphas %d %d", name, g.Background.A, g.Container.Background.A)
		}
		if g.Terminal != th.Terminal {
			t.Errorf("%s: the terminal colours changed", name)
		}
		if th.Background != before.Background || th.Row.Active.Background != before.Row.Active.Background || th.Border != before.Border {
			t.Errorf("%s: the opaque theme changed", name)
		}
	}
}
