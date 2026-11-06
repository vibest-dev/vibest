package app

import (
	"errors"
	"sync"
	"vibest-desktop/internal/core"

	"time"

	"vibest-desktop/internal/chrome"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

type App struct {
	coreWindow
	socket string
	look   terminal.Options

	invalidate func()
	notify     func(paneID, title, body string)
	setTitle   func(string)
	bell       func()

	mu sync.Mutex
	*machine
	machines []*machine
	toast    string
	open     []string
	opened   string
	notices  []notice

	activeTabDrag *tabDrag

	fontSize float32
	g        viewportMetrics

	macWin               *mygo.Window
	dialog               *dialog
	nativeDialog         *dialog
	collapsed            map[string]map[string]bool
	foldedMachines       map[string]bool
	sideWidth            float32
	sidebarVisible       bool
	sideMoving           bool
	sideAt               float32
	winW, shellTop       float32
	styleAt              float32
	styled               bool
	styleMoving          bool
	sideScroll           ui.ScrollState
	rightToPane          map[string]bool
	menuPane             string
	navigationGeneration uint64
	navigationNote       string
	returnFocus          bool
	paneBox              ui.Rect

	themes        themes
	th            *chrome.Theme
	windowFocused bool
	windowClosed  bool
	native        chan struct{}
}

type dialog struct {
	title, value string
	detail       string
	confirm      bool
	action       string
	safe         bool
	open         bool
	run          func(value string)
	cancel       func()
	generation   uint64
}

type notice struct {
	Machine string    `json:"machine,omitempty"`
	PaneID  string    `json:"pane_id"`
	Title   string    `json:"title"`
	Body    string    `json:"-"`
	At      time.Time `json:"at"`
}

func NewApp(socket string) *App {
	local := newMachine(nil)
	a := &App{
		machine:        local,
		machines:       []*machine{local},
		socket:         socket,
		coreWindow:     newCoreWindow(),
		invalidate:     func() {},
		notify:         func(string, string, string) {},
		setTitle:       func(string) {},
		bell:           func() {},
		collapsed:      map[string]map[string]bool{},
		foldedMachines: map[string]bool{},
		sideWidth:      chrome.SidebarWidth,
		sidebarVisible: true,
		themes:         themes{settings: chrome.DefaultSettings(), light: chrome.Light, dark: chrome.Dark},
		th:             chrome.Light,
		windowFocused:  true,
	}
	return a
}

func (a *App) SetLook(look terminal.Options) { a.look = look }

type Host struct {
	Window        *mygo.Window
	Invalidate    func()
	SetTitle      func(string)
	Bell          func()
	Notify        func(paneID, title, body string)
	SetAppearance func(string)
	SetMenu       func(*mygo.Menu)
	SetWindowDark func(bool)
	SetVibrancy   func(bool)
}

func (a *App) Attach(h Host) {
	a.macWin = h.Window
	if h.Invalidate != nil {
		a.invalidate = h.Invalidate
	}
	if h.SetTitle != nil {
		a.setTitle = h.SetTitle
	}
	if h.Bell != nil {
		a.bell = h.Bell
	}
	if h.Notify != nil {
		a.notify = h.Notify
	}
	a.mu.Lock()
	if a.native == nil && (h.SetMenu != nil || h.SetAppearance != nil || h.SetWindowDark != nil || h.SetVibrancy != nil) {
		a.native = make(chan struct{}, 1)
		go a.nativeLoop(a.native, h)
	}
	a.syncNative()
	a.mu.Unlock()
}

func poke(c chan struct{}) {
	select {
	case c <- struct{}{}:
	default:
	}
}

func (a *App) fail(err error) {
	a.mu.Lock()
	a.err = err.Error()
	a.mu.Unlock()
	a.invalidate()
}

func (a *App) NewWorkspace() {
	a.coreCreate("", "", "")
}

func (a *App) CloseWorkspace(id string) {
	a.coreCloseGroup(id, "")
}

func (a *App) CloseWorkspaceGroup(id string) {
	var repository, machine string
	for _, w := range a.coreState.Layout.Workspaces {
		if w.ID == id {
			repository, machine = w.Repository, w.Machine
			break
		}
	}
	if repository == "" {
		a.coreCloseGroup(id, "")
		return
	}
	var ids []string
	for _, w := range a.coreState.Layout.Workspaces {
		if w.Repository == repository && w.Machine == machine {
			for _, tab := range w.Tabs {
				walkCorePanes(tab.Root, func(p *core.Pane) { ids = append(ids, p.ID) })
			}
		}
	}
	a.coreClose(ids)
}

func (a *App) CreateWorktree(id, branch string) {
	a.coreWorktree(id, branch, true)
}

func (a *App) OpenWorktree(id, path string) {
	a.coreWorktree(id, path, false)
}

func (a *App) RemoveWorktree(id string) {
	a.coreRemoveWorktree(id)
}

func (a *App) NewTab(workspaceID string) {
	a.coreCreate(workspaceID, "", "")
}

func (a *App) Split(paneID, direction string) {
	if paneID == "" {
		return
	}
	a.coreCreate("", paneID, direction)
}

func (a *App) CloseTab(id string) {
	a.coreCloseGroup("", id)
}

func (a *App) RenameWorkspace(id, label string) {
	a.coreRename(id, label)
}

func (a *App) toggleSidebar() {
	a.sidebarVisible = !a.sidebarVisible
	a.returnFocus = true
	a.themes.settings.SidebarHidden = !a.sidebarVisible
	a.themes.settings.SidebarWidth = a.sideWidth
	a.saveSettings()
	a.invalidate()
}

func (a *App) RenameTab(id, label string) {
	a.coreRename(id, label)
}

func (a *App) RenamePane(id, label string) {
	a.coreRename(id, label)
}

func (a *App) MoveTab(id string, index int) {
	a.coreMoveTab(id, index)
}

func (a *App) ZoomPane(id string) {
	a.ZoomPaneMode(id, "toggle")
}

func (a *App) ZoomPaneMode(id, mode string) {
	a.coreNavigate(func(s *core.Selection, l *core.Layout) error {
		if mode == "on" && s.Zoom == id || mode == "off" && s.Zoom == "" {
			return nil
		}
		return s.ToggleZoom(l, id)
	})
}

func (a *App) MovePaneNewWorkspace(id string) {
	a.coreEditAndFollow(id, func(l *core.Layout) error {
		p := l.Pane(id)
		if p == nil {
			return errors.New("pane not found")
		}
		copy := *p
		workspace, _ := l.Location(id)
		cwd, machine := "", ""
		for _, w := range l.Workspaces {
			if w.ID == workspace {
				cwd, machine = w.CWD, w.Machine
			}
		}
		if err := l.RemovePane(id); err != nil {
			return err
		}
		l.AddWorkspace("", cwd, machine, copy)
		return nil
	})
}

func (a *App) EditScrollback(id string) {
	a.coreEditScrollback(id)
}

func (a *App) SetRightClicks(id string, toPane bool) {
	if !a.coreTargetActionAllowed() {
		return
	}
	v := a.coreViews[id]
	if v == nil || !v.InputReady() {
		return
	}
	if a.rightToPane == nil {
		a.rightToPane = map[string]bool{}
	}
	a.rightToPane[id] = toPane
}

func (a *App) FocusDirection(id, dir string) {
	a.coreFocusDirection(id, dir)
}

func (a *App) ResizePane(id, dir string) {
	a.coreResizePane(id, dir)
}

func (a *App) ClearPane(id string) {
	if v := a.coreViews[id]; v != nil {
		v.VT.ClearScreen()
	}
}

func (a *App) SelectWorkspace(id string) {
	visit := a.captureCoreVisit(activityScope{workspace: id})
	if a.coreNavigate(func(s *core.Selection, l *core.Layout) error { return s.SelectWorkspace(l, id) }) {
		a.acknowledgeCoreVisit(visit)
	}
}

func (a *App) SelectTab(id string) {
	visit := a.captureCoreVisit(activityScope{tab: id})
	if a.coreNavigate(func(s *core.Selection, l *core.Layout) error { return s.SelectTab(l, id) }) {
		a.acknowledgeCoreVisit(visit)
	}
}

func (a *App) ShowPane(id string) {
	visit := a.captureCoreVisit(activityScope{pane: id})
	if a.coreNavigate(func(s *core.Selection, l *core.Layout) error { return s.SelectPane(l, id) }) {
		a.acknowledgeCoreVisit(visit)
	}
}

func (a *App) Reconnect() {
	poke(a.coreRetry)
}

func (a *App) WindowClosed() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.windowClosed {
		return
	}
	a.windowClosed = true
	a.coreSelect(nil)
	a.cancelNavigation()
	a.navigationGeneration++
	a.returnFocus = false
	if d := a.nativeDialog; d != nil {
		a.nativeDialog = nil
		if d.cancel != nil {
			d.cancel()
		}
	}
}

func (a *App) Focus(focused bool) {
	a.mu.Lock()
	if !focused {
		if d := a.activeTabDrag; d != nil {
			d.canceled = true
		}
		a.cancelNavigation()
		if a.nativeDialog == nil {
			a.navigationGeneration++
		}
	}
	a.windowFocused = focused
	a.coreFocus()
	a.mu.Unlock()
	a.invalidate()
}
