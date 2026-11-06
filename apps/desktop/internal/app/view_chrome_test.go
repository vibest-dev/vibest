package app

import (
	"image"
	"image/color"
	"slices"
	"strings"
	"testing"
	"vibest-desktop/internal/core"

	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo/ui"
)

func TestChromeShell(t *testing.T) {
	app, f, tt, _ := themedCoreApp(t, "")
	publishCoreLayout(t, app, f, func(f *coreAppFixture) {
		f.layout.Workspaces[0].Label = "ReHerdr"
		f.layout.Workspaces[0].Tabs[0].Label = "shell"
		f.layout.Workspaces[0].Tabs[1].Label = "logs"
		f.layout.Workspaces[1].Label = "other"
	})
	tt.Frame()

	img := tt.Image()
	if img == nil || img.Bounds().Dx() < 100 || img.Bounds().Dy() < 100 {
		t.Fatal("frame is blank")
	}
	joined := strings.Join(tt.Texts(), "\n")
	for _, want := range []string{"Projects", "Terminals", "shell", "logs", "new-workspace"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in\n%s", want, joined)
		}
	}
	for _, want := range []string{"New tab", "Theme"} {
		r, ok := tt.Find(want)
		if !ok {
			t.Errorf("no control %q", want)
		} else if r.W != chrome.Light.IconButton || r.H != chrome.Light.IconButton {
			t.Errorf("%s is %v, want the shared %v square", want, r, chrome.Light.IconButton)
		}
	}
	if strings.Contains(joined, "Workspaces") {
		t.Fatalf("workspace heading still shown:\n%s", joined)
	}
	if strings.Contains(joined, "New Chat") || strings.Contains(joined, "Automations") || strings.Contains(joined, "Repositories") {
		t.Fatalf("fake cursor entries shown:\n%s", joined)
	}

	side := img.RGBAAt(4, 200)
	if !nearColor(side, chrome.Light.Sidebar) {
		t.Errorf("sidebar %v, want %v", side, chrome.Light.Sidebar)
	}
	name, ok := tt.Find("Terminals")
	if !ok {
		t.Fatal("selected workspace not found")
	}
	sel := img.RGBAAt(int(name.X)+4, int(name.Y+name.H/2))
	if !nearColor(sel, chrome.Light.Row.Active.Background) {
		t.Errorf("selection %v at %v, want %v", sel, name, chrome.Light.Row.Active.Background)
	}

	panes, ok := tt.Find("Panes")
	if !ok || panes.W < 200 || panes.H < 200 {
		t.Fatalf("panes rect %v", panes)
	}
	if panes.X < float32(chrome.SidebarWidth) {
		t.Fatalf("panes x=%v, want inset past the sidebar", panes.X)
	}
	tab, ok := tt.Find("shell")
	if !ok {
		t.Fatal("tab not found")
	}
	if _, ok := tt.Find("Zoom"); ok {
		t.Fatal("zoom is still on the tab row")
	}
	if name.X >= float32(chrome.SidebarWidth) {
		t.Fatalf("workspace %v is outside the sidebar", name)
	}
	if tab.X < float32(chrome.SidebarWidth) {
		t.Fatalf("tab overlaps the sidebar: %v", tab)
	}
	if tab.Y+tab.H > panes.Y+2 {
		t.Fatalf("tabs are not above the terminal: tab %v panes %v", tab, panes)
	}
	term := chrome.Light.Terminal.Background
	center := img.RGBAAt(int(panes.X+panes.W/2), int(panes.Y+40))
	if !nearColor(center, term) {
		t.Errorf("center %v, want %v", center, term)
	}
	box, ok := tt.Find("pane-container")
	if !ok || box != panes {
		t.Errorf("container %v panes %v, want the panes to fill the container", box, panes)
	}

	terminalWorkspace(t, tt, "other")
	if app.coreSelection.Workspace != "w2" {
		t.Fatal("workspace click failed")
	}
	terminalWorkspace(t, tt, "ReHerdr")
	if err := tt.Click("logs"); err != nil {
		t.Fatal(err)
	}
	if app.coreSelection.Tab != "t2" {
		t.Fatal("tab click failed")
	}
	noLegacyNavigation(t, f)

	tt.SetDark(true)
	dark := tt.Image().RGBAAt(4, 200)
	if !nearColor(dark, chrome.Dark.Sidebar) {
		t.Errorf("dark sidebar %v, want %v", dark, chrome.Dark.Sidebar)
	}
}

func nearColor(got color.RGBA, want ui.Color) bool {
	d := func(a, b uint8) int {
		if a > b {
			return int(a - b)
		}
		return int(b - a)
	}
	return d(got.R, want.R) < 12 && d(got.G, want.G) < 12 && d(got.B, want.B) < 12
}

func TestSplitLineFollowsHit(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "split")
	ps := corePaneGeometries(t, a, tt)
	area := find(t, tt, "Panes")
	x, y := area.X+ps[0].card.W+cardGap(1)/2, area.Y+100
	if got := tt.Image().RGBAAt(int(x), int(y)); !nearColor(got, chrome.Light.Background) {
		t.Fatal("split gap not window background", got)
	}
	before := a.coreState.Layout.Tab("t").Root.Ratio
	tt.Press(x, y)
	tt.Move(x+20, y)
	tt.Release(x+20, y)
	awaitCoreApp(t, a, func() bool { return a.coreState.Version == 1 })
	if a.coreState.Layout.Tab("t").Root.Ratio <= before || a.coreSelection.Pane != "a" {
		t.Fatal("hit did not move its split or stole focus")
	}
	tt.Type("x")
	wantCorePaneInput(t, f, "a", "x")
	noCoreData(t, f)
}

func TestPaneMenuOpens(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "split")
	v := coreOutput(t, a, f, tt, "a", "\x1b[?1002h\x1b[?1006h")
	if err := tt.RightClick("terminal/a"); err != nil {
		t.Fatal(err)
	}
	for _, item := range []string{"Rename pane", "Split right", "Split down", "Zoom", "Send right-clicks to pane", "Close pane"} {
		if !slices.Contains(tt.Menu(), item) {
			t.Fatal("missing menu item", item)
		}
	}
	if tt.HasText("menu: Rename pane") {
		t.Fatal("menu drawn in window")
	}
	if err := tt.ChooseMenuItem("Close pane"); err != nil {
		t.Fatal(err)
	}
	if a.dialog == nil || len(coreRequests(f, "terminal.kill")) != 0 {
		t.Fatal("menu close did not confirm")
	}
	tt.Key(0, ui.KeyEscape)
	readyCorePane(t, a, tt, "a")
	if err := tt.RightClick("terminal/a"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Send right-clicks to pane"); err != nil {
		t.Fatal(err)
	}
	r := vtCell(t, tt, v, "a", 3, 3)
	tt.RightClickAt(float32(r.Min.X+r.Max.X)/2, float32(r.Min.Y+r.Max.Y)/2)
	if slices.Contains(tt.Menu(), "Rename pane") {
		t.Fatal("routed click opened menu")
	}
	wantCorePaneInput(t, f, "a", "\x1b[<2;4;4M")
	wantCorePaneInput(t, f, "a", "\x1b[<2;4;4m")
	noCoreData(t, f)
}

func TestDialogAndPaneMenuCoverTheBottomGap(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "split")
	a.ask("Name the workspace", "", false, func(string) {})
	tt.Frame()
	find(t, tt, "Name the workspace")
	tt.ClickAt(640, 798)
	absent(t, tt, "Name the workspace")
	readyCorePane(t, a, tt, "a")
	if err := tt.RightClick("terminal/a"); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(tt.Menu(), "Send right-clicks to pane") {
		t.Fatal("pane menu did not open")
	}
	tt.ClickAt(640, 798)
	if tt.HasText("menu: Send right-clicks to pane") {
		t.Fatal("menu painted as window content")
	}
	tt.CloseMenu()
	noCoreData(t, f)
}

func TestClampSidebar(t *testing.T) {
	if got := clampSidebar(chrome.SidebarWidth, 1280); got != chrome.SidebarWidth {
		t.Fatalf("default %v", got)
	}
	if got := clampSidebar(40, 1280); got != chrome.SidebarMin {
		t.Fatalf("min %v", got)
	}
	if got := clampSidebar(2000, 1280); got != float32(1280)*chrome.SidebarMaxFrac {
		t.Fatalf("max %v", got)
	}
	if got := clampSidebar(400, 400); got != chrome.SidebarMin {
		t.Fatalf("narrow window %v", got)
	}
}

func TestRunningMarkShowsOnAWorkingTab(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	reportActivity(t, a, f, "a", "working", 0, true)
	reportActivity(t, a, f, "b", "idle", 0, true)
	reportActivity(t, a, f, "c", "idle", 0, true)
	reportActivity(t, a, f, "d", "idle", 0, true)
	for _, dark := range []bool{false, true} {
		tt.SetDark(dark)
		tt.Frame()
		name := find(t, tt, "Build")
		spinner := find(t, tt, "activity: working")
		if spinner.X <= name.X+name.W || spinner.W != a.th.Slot || spinner.H != a.th.Slot {
			t.Fatal("activity not trailing", name, spinner)
		}
		for _, s := range tt.Texts() {
			if strings.HasPrefix(s, "status:") {
				t.Fatal("redundant leading status")
			}
		}
		absent(t, tt, "activity: done")
	}
	noCoreData(t, f)
}

func TestTabsShareOneWidthAndThePaneSharesTheBottomGap(t *testing.T) {
	const winW, winH = 1280, 800
	app, f, tt, _ := themedCoreApp(t, "")
	publishCoreLayout(t, app, f, func(f *coreAppFixture) {
		f.layout.Workspaces[0].Tabs[0].ID = "t1"
		f.layout.Workspaces[0].Tabs[0].Label = "1"
		f.layout.Workspaces[0].Tabs[1].Label = "a very long tab name that should truncate"
	})
	tt.Frame()

	short, ok := tt.Find("tab/t1")
	long, ok2 := tt.Find("tab/t2")
	if !ok || !ok2 {
		t.Fatalf("tabs short %v %v long %v %v", short, ok, long, ok2)
	}
	if short.W != chrome.Light.TabWidth || long.W != chrome.Light.TabWidth {
		t.Fatalf("tab widths short %v long %v, want both %v", short.W, long.W, chrome.Light.TabWidth)
	}
	name, ok := tt.Find("a very long tab name that should truncate")
	if !ok || name.W >= short.W {
		t.Fatalf("long name %v was not cut to the tab", name)
	}
	plus, ok := tt.Find("New tab")
	if !ok || plus.W >= chrome.Light.TabWidth-1 {
		t.Fatalf("new tab %v ok %v, want narrower than a tab", plus, ok)
	}

	sidebar, ok := tt.Find("sidebar")
	grip, ok2 := tt.Find("sidebar-grip")
	column, ok3 := tt.Find("main-column")
	if !ok || !ok2 || !ok3 {
		t.Fatalf("sidebar %v %v grip %v %v column %v %v", sidebar, ok, grip, ok2, column, ok3)
	}
	if sidebar.X != 0 || grip.X != sidebar.X+sidebar.W || column.X != grip.X+grip.W || column.X+column.W != winW-outerPad {
		t.Fatalf("sidebar %v grip %v column %v, want the card to stop %v short of the window", sidebar, grip, column, outerPad)
	}
	for _, box := range []ui.Rect{sidebar, grip} {
		if box.Y != 0 || box.Y+box.H != winH {
			t.Fatalf("box %v, want the full window height", box)
		}
	}
	pull := min(headerGap(windowChromeMin, chrome.Light.IconButton, 1), 0)
	if !nearDip(column.Y, windowChromeMin+pull) || !nearDip(column.Y+column.H, winH-outerPad) {
		t.Fatalf("column %v, want it %v under the tab and %v above the bottom", column, outerPad, outerPad)
	}
	panes, ok := tt.Find("Panes")
	if !ok || panes.Y+panes.H != winH-outerPad {
		t.Fatalf("panes %v ok %v, want the bottom at the column's", panes, ok)
	}

	list, ok := tt.Find("workspace-list")
	btn, ok2 := tt.Find("Theme")
	if !ok || !ok2 {
		t.Fatalf("list %v %v button %v %v", list, ok, btn, ok2)
	}
	if gap := btn.Y - (list.Y + list.H); gap < 0 || gap > 8 {
		t.Fatalf("list %v button %v, want the list down to the theme control", list, btn)
	}
}

func TestTabCloseMarkShowsOnHover(t *testing.T) {
	app, f, tt, _ := themedCoreApp(t, "")
	publishCoreLayout(t, app, f, func(f *coreAppFixture) {
		f.layout.Workspaces[0].Tabs[0].ID = "t1"
		f.layout.Workspaces[0].Tabs[0].Label = "1"
		f.layout.Workspaces[0].Tabs[1].Label = "logs"
	})
	tt.Frame()

	if tt.HasText("×") {
		t.Fatal("a close mark shows before the pointer is over a tab")
	}
	tab, ok := tt.Find("tab/t2")
	name, ok2 := tt.Find("logs")
	slot := ui.Rect{X: tab.X + tab.W - 10 - chrome.Light.Slot, Y: tab.Y + (tab.H-chrome.Light.Slot)/2, W: chrome.Light.Slot, H: chrome.Light.Slot}
	if !ok || !ok2 {
		t.Fatalf("tab %v %v name %v %v", tab, ok, name, ok2)
	}
	if tab.W != chrome.Light.TabWidth {
		t.Fatalf("tab width %v, want %v", tab.W, chrome.Light.TabWidth)
	}
	tt.Move(name.X+4, name.Y+name.H/2)
	mark, ok := tt.Find("close/t2")
	if !ok || tt.HasText("×") {
		t.Fatal("hovering a tab shows no close icon")
	}
	mw, mh := contrastSpan(tt.Image(), mark, chrome.Light.Secondary)
	if mw < 8 || mw > 12 || mh < 8 || mh > 12 {
		t.Fatalf("close icon ink %dx%d, want about %v", mw, mh, chrome.Light.Mark)
	}
	absent(t, tt, "status: blocked", "status: working")
	if mark.X != slot.X || mark.W != slot.W || mark.H != slot.H {
		t.Fatalf("close mark %v, want the status slot %v", mark, slot)
	}
	if mark.W != chrome.Light.Slot || mark.H != chrome.Light.Slot {
		t.Fatalf("close slot %v, want %v", mark, chrome.Light.Slot)
	}
	again, _ := tt.Find("tab/t2")
	name2, _ := tt.Find("logs")
	if again.W != tab.W || name2.W != name.W || name2.X != name.X {
		t.Fatalf("hover moved the tab or the name: tab %v→%v name %v→%v", tab, again, name, name2)
	}
	if _, ok := tt.Find("close/t1"); ok {
		t.Fatal("the tab that is not hovered has a close mark")
	}
	if err := tt.Click("close/t2"); err != nil {
		t.Fatal(err)
	}
	if app.dialog == nil || app.coreSelection.Tab != "t1" || len(coreRequests(f, "terminal.kill")) != 0 {
		t.Fatal("close focused/acted before confirmation")
	}
	tt.Key(0, ui.KeyEscape)
	tt.Move(0, 0)
	rest := find(t, tt, "logs")
	tt.ClickAt(rest.X+4, rest.Y+rest.H/2)
	if app.coreSelection.Tab != "t2" {
		t.Fatal("click failed after canceled close")
	}
	noCoreData(t, f)
}

func TestActivityAndMarkStayInsideTheSlot(t *testing.T) {
	if chrome.Light.Mark > chrome.Light.Slot || chrome.Dark.Mark > chrome.Dark.Slot {
		t.Fatalf("mark %v is larger than slot %v", chrome.Light.Mark, chrome.Light.Slot)
	}
	if chrome.Light.Slot != chrome.Step12 || chrome.Light.GroupIndent != chrome.Step12 {
		t.Fatalf("scale slot %v indent %v", chrome.Light.Slot, chrome.Light.GroupIndent)
	}
	if chrome.Light.TabWidth != 140 {
		t.Fatalf("tab width %v", chrome.Light.TabWidth)
	}
	app, f, tt := coreActivityUI(t)
	reportActivity(t, app, f, "a", "working", 1, true)
	tt.SetDark(false)
	tt.Frame()
	indicator, ok := tt.Find("activity: working")
	if !ok {
		t.Fatal("working activity missing")
	}
	if indicator.W != chrome.Light.Slot || indicator.H != chrome.Light.Slot {
		t.Fatalf("activity slot %v, want %v", indicator, chrome.Light.Slot)
	}
	img := tt.Image()
	c := img.RGBAAt(int(indicator.X), int(indicator.Y))
	dw, dh := contrastSpan(img, indicator, ui.Color{R: c.R, G: c.G, B: c.B, A: 255})
	if dw < 8 || dw > 12 || dh < 8 || dh > 12 {
		t.Fatalf("working indicator ink %dx%d", dw, dh)
	}
	name, ok := tt.Find("Build")
	if !ok {
		t.Fatal("tab name missing")
	}
	tt.Move(name.X+4, name.Y+name.H/2)
	mark, ok := tt.Find("close/t1")
	if !ok || tt.HasText("×") {
		t.Fatal("close icon missing")
	}
	if mark.W != chrome.Light.Slot || mark.H != chrome.Light.Slot {
		t.Fatalf("close slot %v", mark)
	}
	mw, mh := contrastSpan(tt.Image(), mark, chrome.Light.Tab.Active.Background)
	if mw < 8 || mw > 12 || mh < 8 || mh > 12 {
		t.Fatalf("close mark ink %dx%d, want about %v", mw, mh, chrome.Light.Mark)
	}
}

func TestCloseIconHoverState(t *testing.T) {
	for _, dark := range []bool{false, true} {
		th := chrome.Light
		if dark {
			th = chrome.Dark
		}
		app, f, tt, _ := themedCoreApp(t, "")
		reportActivity(t, app, f, "a", "working", 0, true)
		publishCoreLayout(t, app, f, func(f *coreAppFixture) {
			f.layout.Workspaces[0].Tabs[0].ID = "t1"
			f.layout.Workspaces[0].Tabs[0].Label = "shell"
		})
		tt.SetDark(dark)
		tt.Frame()

		name, ok := tt.Find("shell")
		if !ok {
			t.Fatal("tab name missing")
		}
		workingBefore := strings.Count(strings.Join(tt.Texts(), "\n"), "activity: working")
		tt.Move(name.X+4, name.Y+name.H/2)
		mark, ok := tt.Find("close/t1")
		if !ok {
			t.Fatal("close icon missing")
		}
		x, y, ok := interiorFill(tt.Image(), mark, th.Tab.Active.Background)
		if !ok {
			t.Fatal("close icon has no gap inside the slot")
		}
		before := tt.Image().RGBAAt(x, y)
		tt.Move(float32(x)+0.5, float32(y)+0.5)
		again, ok := tt.Find("close/t1")
		name2, ok2 := tt.Find("shell")
		if !ok || !ok2 {
			t.Fatal("hovering the close icon removed it or the name")
		}
		if got := strings.Count(strings.Join(tt.Texts(), "\n"), "activity: working"); got != workingBefore-1 {
			t.Fatal("tab activity was not replaced by close")
		}
		if again.W != th.Slot || again.H != th.Slot || again.X != mark.X || again.Y != mark.Y {
			t.Fatalf("hover grew or moved the slot: %v → %v", mark, again)
		}
		if name2.X != name.X || name2.W != name.W {
			t.Fatalf("hover moved the name: %v → %v", name, name2)
		}
		got := tt.Image().RGBAAt(x, y)
		if nearColor(got, th.Tab.Active.Background) || got == before {
			t.Fatalf("dark %v: close hover pixel %v, still the tab fill %v", dark, got, th.Tab.Active.Background)
		}
		if !nearColor(got, th.Danger) {
			t.Fatalf("dark %v: close hover pixel %v, want %v", dark, got, th.Danger)
		}
	}
}

func interiorFill(img *image.RGBA, r ui.Rect, fill ui.Color) (x, y int, ok bool) {
	best := 12 * 3
	cx, cy := int(r.X+r.W/2), int(r.Y+r.H/2)
	consider := func(px, py int) {
		if px < int(r.X)+1 || py < int(r.Y)+1 || px >= int(r.X+r.W)-1 || py >= int(r.Y+r.H)-1 {
			return
		}
		p := img.RGBAAt(px, py)
		d := colorDist(p, fill)
		if d < best {
			best, x, y, ok = d, px, py, true
		}
	}
	for i := 1; i < int(r.W)-1; i++ {
		consider(int(r.X)+i, cy)
	}
	for i := 1; i < int(r.H)-1; i++ {
		consider(cx, int(r.Y)+i)
	}
	return x, y, ok
}

func colorDist(got color.RGBA, want ui.Color) int {
	d := func(a, b uint8) int {
		if a > b {
			return int(a - b)
		}
		return int(b - a)
	}
	return d(got.R, want.R) + d(got.G, want.G) + d(got.B, want.B)
}

func contrastSpan(img *image.RGBA, r ui.Rect, fill ui.Color) (w, h int) {
	return spanIf(img, r, func(p color.RGBA) bool { return !nearColor(p, fill) })
}

func spanIf(img *image.RGBA, r ui.Rect, match func(color.RGBA) bool) (w, h int) {
	minX, minY := int(r.X+r.W), int(r.Y+r.H)
	maxX, maxY := int(r.X)-1, int(r.Y)-1
	for y := int(r.Y); y < int(r.Y+r.H); y++ {
		for x := int(r.X); x < int(r.X+r.W); x++ {
			if !match(img.RGBAAt(x, y)) {
				continue
			}
			if x < minX {
				minX = x
			}
			if y < minY {
				minY = y
			}
			if x > maxX {
				maxX = x
			}
			if y > maxY {
				maxY = y
			}
		}
	}
	if maxX < minX || maxY < minY {
		return 0, 0
	}
	return maxX - minX + 1, maxY - minY + 1
}

func TestFlushThumbSitsOnTheSidebarEdge(t *testing.T) {
	box := ui.Rect{X: 10, Y: 20, W: 200, H: 400}
	cover, thumb, ok := flushThumb(box, 0, 400, 6)
	if !ok {
		t.Fatal("an overflowing list draws no thumb")
	}
	if thumb.X+thumb.W != box.X+box.W {
		t.Fatalf("thumb %v, want its right edge on the box", thumb)
	}
	if cover.X != thumb.X-5 || cover.X+cover.W != thumb.X+thumb.W {
		t.Fatalf("cover %v, want it to hide the whole native thumb under %v", cover, thumb)
	}
	if _, _, ok := flushThumb(box, 0, 0, 6); ok {
		t.Fatal("a list that fits draws a thumb")
	}
	if chrome.Light.Widget().Scrollbar.A == 0 || chrome.Dark.Widget().Scrollbar.A == 0 {
		t.Fatal("no thumb color")
	}
}

func TestSidebarMenus(t *testing.T) {
	a, f, tt := machinesCoreApp(t)
	git := &fakeGit{fail: "rev-parse", gate: make(chan struct{}), entered: make(chan struct{})}
	gate := git.gate
	coreAppAct(a, func() { a.gitExec = git.run })
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		for i := range f.layout.Workspaces {
			if f.layout.Workspaces[i].Machine == "" {
				f.layout.Workspaces[i].CWD = "/inert/repo"
			}
		}
	})
	tt.Frame()
	if err := tt.Click("Terminals"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("lparent", "New worktree"); err != nil {
		t.Fatal(err)
	}
	tt.Type("branch")
	tt.Key(0, ui.KeyEnter)
	coreAppAct(a, func() {
		if !a.corePending {
			t.Fatal("worktree request did not own navigation")
		}
	})
	tt.Type("unsent")
	<-git.entered
	close(gate)
	awaitCoreApp(t, a, func() bool { return a.coreOperationNote != "" && a.coreBlocked })
	if navigationNote(a) != navigationLost {
		t.Fatal("failed worktree request lost unsent-input explanation")
	}
	noCoreData(t, f)
	if len(coreRequests(f, "terminal.run"))+len(coreRequests(f, "doc.set")) != 0 {
		t.Fatal("failed Git route mutated Core")
	}
	coreAppAct(a, func() { a.ShowPane(a.coreState.Layout.Workspaces[0].Tabs[0].Root.Pane.ID) })
	readyCorePane(t, a, tt, a.coreSelection.Pane)
	tt.Click("Terminals")
	if err := tt.ChooseMenuItem("rnotes", "Close"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if a.dialog == nil {
		t.Fatal("remote row close bypassed confirmation")
	}
	tt.Key(0, ui.KeyEscape)
	noCoreData(t, f)
}

func TestSelectionKeepsSidebarGeometry(t *testing.T) {
	newsprint, _ := chrome.Builtin("Newsprint")
	themes := []*chrome.Theme{chrome.Light, newsprint, chrome.Dark, chrome.Ghostty(chrome.Light.Terminal)}
	rows := []string{"Projects", "Terminals", "new-workspace"}
	tabs := []string{"tab/t1", "shell", "tab/t2", "logs"}
	for _, th := range themes {
		for _, scale := range []float32{1, 1.25, 1.5, 2} {
			for _, focused := range []bool{true, false} {
				app, tt := selectionApp(t, th, scale)
				app.Focus(focused)
				tt.SetFocused(focused)
				check := func(names []string, base map[string]ui.Rect, pick func(), what string) map[string]ui.Rect {
					t.Helper()
					pick()
					tt.Frame()
					m := map[string]ui.Rect{}
					for _, s := range names {
						r, ok := tt.Find(s)
						if !ok {
							t.Fatalf("%s: no %q", th.Name, s)
						}
						if base != nil && r != base[s] {
							t.Fatalf("%s x%v focused=%v: selecting %s moved %q %v -> %v", th.Name, scale, focused, what, s, base[s], r)
						}
						m[s] = r
					}
					return m
				}
				workspace := func(id string) func() { return func() { coreAppAct(app, func() { app.SelectWorkspace(id) }) } }
				tab := func(id string) func() { return func() { coreAppAct(app, func() { app.SelectTab(id) }) } }
				base := check(rows, nil, func() {}, "")
				for i := 0; i < 5; i++ {
					for _, id := range []string{"ws1", "ws2", "ws3"} {
						check(rows, base, workspace(id), id)
					}
				}
				coreAppAct(app, func() { app.SelectWorkspace("ws1") })
				base = check(tabs, nil, func() {}, "")
				for i := 0; i < 5; i++ {
					for _, id := range []string{"t1", "t2"} {
						check(tabs, base, tab(id), id)
					}
				}
			}
		}
	}
}

func selectionApp(t *testing.T, th *chrome.Theme, scale float32) (*App, *ui.Tester) {
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		pane := func(id string) *core.Split {
			f.terminals[id] = core.Terminal{Address: id, State: "live", Cols: 80, Rows: 24}
			return &core.Split{Pane: &core.Pane{ID: id, Terminal: core.TerminalRef{CoreID: f.layout.CoreID, Address: id}}}
		}
		f.layout.Workspaces = []core.Workspace{
			{ID: "ws1", Label: "repo", CWD: "/inert/repo", Repository: "/inert/repo/.git", Branch: "main", Tabs: []core.Tab{{ID: "t1", Label: "shell", Root: pane("p1")}, {ID: "t2", Label: "logs", Root: pane("p2")}}},
			{ID: "ws2", Label: "feat", CWD: "/inert/feat", Repository: "/inert/repo/.git", Linked: true, Branch: "feat-x", Tabs: []core.Tab{{ID: "t3", Root: pane("p3")}}},
			{ID: "ws3", Label: "plain", CWD: "/inert/plain", Tabs: []core.Tab{{ID: "t4", Root: pane("p4")}}},
			{ID: "ws4", Label: "other", CWD: "/inert/other", Branch: "dev", Tabs: []core.Tab{{ID: "t5", Root: pane("p5")}}},
		}
	})
	_ = f
	coreAppAct(a, func() { a.themes.light = th; a.themes.dark = th; a.themes.settings.FollowSystem = false })
	tt := ui.NewTester(a.View, 1280, 800)
	tt.SetScale(scale)
	tt.SetDark(th.Dark)
	readyCorePane(t, a, tt, "p1")
	return a, tt
}
