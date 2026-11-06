package app

import (
	"encoding/json"
	"github.com/egoist/mygo/ui"
	"testing"
	"vibest-desktop/internal/core"
)

func tabPreedit(t *testing.T, a *App) string {
	t.Helper()
	return vtView(t, a.coreViews["p-t1"]).FieldByName("preedit").String()
}
func TestTabDragTerminalFocusAndComposition(t *testing.T) {
	for _, style := range []string{paneCompact, paneComfortable} {
		for _, finish := range []string{"drop", "escape", "outside", "self", "end"} {
			t.Run(style+finish, func(t *testing.T) {
				a, f, _, tt := tabDragFixture(t, style)
				v := a.coreViews["p-t1"]
				tt.Compose("字", 1)
				tt.Frame()
				if tabPreedit(t, a) != "字" {
					t.Fatal("missing composition")
				}
				finishTabGesture(t, tt, finish, "t1")
				moves := 0
				if finish == "drop" || finish == "end" {
					moves = 1
					want := []string{"t2", "t3", "t1", "t4"}
					if finish == "end" {
						want = []string{"t2", "t3", "t4", "t1"}
					}
					wantTabOrder(t, a, tt, want...)
				}
				if !tt.Focused("terminal/p-t1") || a.coreViews["p-t1"] != v || tabPreedit(t, a) != "字" {
					t.Fatal("drag changed native composition owner")
				}
				tabDragOnly(t, a, f, moves)
				if !tt.CommitTextNative("字") {
					t.Fatal("native commit lost")
				}
				wantCorePaneInput(t, f, "p-t1", "字")
				tt.TypeKeyNative(0, ui.KeyX, "x")
				wantCorePaneInput(t, f, "p-t1", "x")
				noCoreData(t, f)
			})
		}
	}
}
func TestTabDragDoesNotRebindAcrossEpochDuringGesture(t *testing.T) {
	a, f, _, tt := tabFixture(t, "t1", "t2", "t3")
	startTabGesture(t, a, tt, true)
	original, _ := json.Marshal(a.coreState.Layout)
	next := reconnectCoreApp(t, a, f, func(n *coreAppFixture) {
		json.Unmarshal(original, &n.layout)
		for _, id := range []string{"t1", "t2", "t3"} {
			p := "p-" + id
			n.terminals[p] = core.Terminal{Address: p, State: "live", Cols: 80, Rows: 24}
		}
	})
	tt.Frame()
	d := find(t, tt, "tab/t3")
	tt.Move(d.X+10, d.Y+14)
	tt.Release(d.X+10, d.Y+14)
	tt.Frame()
	if len(coreRequests(next, "doc.set")) != 0 {
		t.Fatal("session replacement restamped old drag")
	}
	noCoreData(t, f)
	noCoreData(t, next)
	finishTabGesture(t, tt, "move", "t1")
	wantTabOrder(t, a, tt, "t2", "t3", "t1")
	if len(coreRequests(next, "doc.set")) != 1 {
		t.Fatal("fresh session gesture failed")
	}
}
