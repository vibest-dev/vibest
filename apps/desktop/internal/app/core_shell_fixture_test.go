package app

import (
	"github.com/egoist/mygo/ui"
	"os"
	"sort"
	"testing"
	"vibest-desktop/internal/core"
)

func coreShellFixture(t *testing.T, w, h int, scale float32, hidden bool, mode string, set ...func(*App)) (*App, *coreAppFixture, *ui.Tester) {
	t.Helper()
	if mode != "" && os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified software VT required")
	}
	var a *App
	var f *coreAppFixture
	if mode == "" {
		a = NewApp("inert-shell-fixture")
	} else {
		a, f = newCoreAppFixtureWith(t, func(f *coreAppFixture) {
			coreActivitySeed(f)
			leaf := func(id string) *core.Split { p := *f.layout.Pane(id); return &core.Split{Pane: &p} }
			var root *core.Split
			switch mode {
			case "single":
				root = leaf("a")
			case "stack":
				root = &core.Split{Axis: "y", Ratio: .5, First: leaf("a"), Second: leaf("b")}
			case "nested":
				root = &core.Split{Axis: "x", Ratio: .5, First: leaf("a"), Second: &core.Split{Axis: "y", Ratio: .5, First: leaf("b"), Second: leaf("c")}}
			default:
				root = &core.Split{Axis: "x", Ratio: .5, First: leaf("a"), Second: leaf("b")}
			}
			f.layout.Workspaces = f.layout.Workspaces[:1]
			f.layout.Workspaces[0].Tabs = []core.Tab{{ID: "t", Label: "Shell", Root: root}}
		})
		if mode == "zoom" {
			coreAppAct(a, func() { a.coreSelection.Zoom = "a" })
		}
	}
	coreAppAct(a, func() {
		a.sidebarVisible = !hidden
		a.look.NoBlink = true
		for _, f := range set {
			f(a)
		}
	})
	tt := ui.NewTester(a.View, max(w, 800), max(h, 400))
	tt.SetScale(scale)
	tt.SetDark(false)
	tt.SetTitleBar(ui.TitleBar{Height: 36, Left: 78})
	if f != nil {
		readyCorePane(t, a, tt, "a")
		for _, id := range []string{"a", "b", "c"} {
			if _, shown := tt.Find("terminal/" + id); shown {
				awaitCorePaintWithoutOwnership(t, a, tt, id)
			}
		}
	}
	tt.SetSize(w, h)
	tt.Frame()
	return a, f, tt
}

type corePaneGeometry struct {
	id               string
	card, head, term ui.Rect
	cols, rows       int
	cw, ch           float32
}

func corePaneGeometries(t *testing.T, a *App, tt *ui.Tester) []corePaneGeometry {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	origin := find(t, tt, "Panes")
	var out []corePaneGeometry
	for id, v := range a.coreViews {
		card, shown := tt.Find("pane/" + id)
		if !shown {
			continue
		}
		head := find(t, tt, "pane-header/"+id)
		r := find(t, tt, "terminal/"+id)
		state := vtView(t, v)
		scale := float32(state.FieldByName("scale").Float())
		cw, ch := float32(state.FieldByName("cellW").Int())/scale, float32(state.FieldByName("cellH").Int())/scale
		cols, rows := int(state.FieldByName("cols").Int()), int(state.FieldByName("rows").Int())
		term := ui.Rect{X: r.X + float32(state.FieldByName("ox").Int())/scale - origin.X, Y: r.Y + float32(state.FieldByName("oy").Int())/scale - origin.Y, W: float32(cols) * cw, H: float32(rows) * ch}
		card.X -= origin.X
		card.Y -= origin.Y
		head.X -= origin.X
		head.Y -= origin.Y
		out = append(out, corePaneGeometry{id, card, head, term, cols, rows, cw, ch})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].card.Y == out[j].card.Y {
			return out[i].card.X < out[j].card.X
		}
		return out[i].card.Y < out[j].card.Y
	})
	return out
}
