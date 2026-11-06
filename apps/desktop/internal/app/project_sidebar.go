package app

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"time"

	"github.com/egoist/mygo/plugins/loading"
	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/vibest"
)

const ProjectLabel = "vibest.project"

type projectWindow struct {
	vibestSocket  string
	dialVibest    func(context.Context, string) (*vibest.Client, error)
	vibestModel   vibest.Model
	vibestNote    string
	vibestCommand []string
	emptyProject  string
	projectOpened func()
	folderPicker  func(start string, run func(string)) bool
	seenWindow
}

func newProjectWindow() projectWindow {
	return projectWindow{vibestSocket: vibest.SocketPath(), dialVibest: vibest.Dial}
}

const (
	vibestBackoffMin = 250 * time.Millisecond
	vibestBackoffMax = 5 * time.Second
)

func (a *App) vibestRun(ctx context.Context) {
	a.mu.Lock()
	socket, dial := a.vibestSocket, a.dialVibest
	a.mu.Unlock()
	if socket == "" {
		return
	}
	backoff := vibestBackoffMin
	for ctx.Err() == nil {
		watched, final := a.vibestWatch(ctx, socket, dial)
		if final {
			return
		}
		if watched {
			backoff = vibestBackoffMin
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, vibestBackoffMax)
	}
}

func (a *App) setVibestNote(note string) {
	a.mu.Lock()
	a.vibestNote = note
	a.mu.Unlock()
	a.invalidate()
}

func (a *App) vibestWatch(ctx context.Context, socket string, dial func(context.Context, string) (*vibest.Client, error)) (watched, final bool) {
	attempt, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	c, err := dial(attempt, socket)
	if err != nil {
		a.setVibestNote("vibestd is not running")
		return false, false
	}
	defer c.Close()
	ping, err := c.Ping(attempt)
	if err != nil {
		a.setVibestNote(vibestMessage(err))
		var mismatch *vibest.ProtocolError
		return false, errors.As(err, &mismatch)
	}
	if !ping.Capabilities["watch"] {
		a.setVibestNote("vibestd " + ping.Version + " cannot stream changes: run vibest update")
		return false, true
	}
	a.mu.Lock()
	a.vibestCommand = ping.Command
	a.mu.Unlock()
	w, err := c.Watch("/")
	if err != nil {
		a.setVibestNote(vibestMessage(err))
		return false, false
	}
	defer w.Close()
	for {
		events, err := w.Next(ctx)
		if err != nil {
			if ctx.Err() == nil {
				a.setVibestNote(vibestMessage(err))
			}
			return watched, false
		}
		a.mu.Lock()
		for _, e := range events {
			a.vibestModel.Apply(e)
		}
		a.vibestNote = ""
		a.mu.Unlock()
		a.invalidate()
		watched = true
	}
}

func (a *App) vibestDo(action func(context.Context, *vibest.Client) error) {
	socket, dial := a.vibestSocket, a.dialVibest
	if socket == "" {
		a.vibestNote = "vibestd is not configured"
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		c, err := dial(ctx, socket)
		if err == nil {
			defer c.Close()
			err = action(ctx, c)
		}
		a.mu.Lock()
		a.vibestNote = ""
		if err != nil {
			a.vibestNote = vibestMessage(err)
		}
		a.mu.Unlock()
		a.invalidate()
	}()
}

func vibestMessage(err error) string {
	var failure *vibest.Error
	if errors.As(err, &failure) {
		if m, ok := failure.Mismatch(); ok {
			return m.Message + " (" + m.Action + ")"
		}
		if failure.Tag == "NotInRepository" {
			return "Not a git checkout or a folder of git checkouts"
		}
		return failure.Error()
	}
	return "vibestd: " + err.Error()
}

func (a *App) projectOpenFolder(dir string) {
	a.vibestDo(func(ctx context.Context, c *vibest.Client) error {
		opened, err := c.OpenProject(ctx, dir, vibest.OpenParams{})
		if err != nil {
			return err
		}
		a.mu.Lock()
		if _, known := a.vibestModel.Projects[opened.ProjectID]; !known {
			directory := opened.Directory
			a.vibestModel.Apply(vibest.Event{Tag: "Project", Project: &vibest.Project{ID: opened.ProjectID, Directory: &directory}})
		}
		a.mu.Unlock()
		return nil
	})
}

func (a *App) mainRunning(p vibest.Project) bool {
	if p.EntrySessionID == nil {
		return false
	}
	s, ok := a.vibestModel.Sessions[*p.EntrySessionID]
	return ok && s.ExitedAt == nil
}

func (a *App) projectStartMain(p vibest.Project) {
	argv := a.vibestCommand
	if len(argv) == 0 {
		argv = []string{"vibest"}
	}
	runtime := "hc"
	dir := directory(p)
	a.vibestDo(func(ctx context.Context, c *vibest.Client) error {
		_, err := c.Launch(ctx, dir, vibest.LaunchParams{Argv: argv, Runtime: &runtime})
		return err
	})
}

func (a *App) sessionArchive(s vibest.Session) {
	a.confirm("Archive "+s.Name+"?", "vibest stops this agent and closes its terminal; a checkout with unsaved work is kept.", "Archive", func() {
		a.vibestDo(func(ctx context.Context, c *vibest.Client) error {
			_, err := c.Remove(ctx, vibest.RemoveParams{ID: s.ID})
			return err
		})
	}, nil)
}

func (a *App) sessionStop(p vibest.Project, s vibest.Session) {
	a.confirm("Stop "+s.Name+"?", "vibest ends this main agent; its terminal stays open.", "Stop", func() {
		a.vibestDo(func(ctx context.Context, c *vibest.Client) error {
			address, err := json.Marshal(s.Address)
			if err != nil {
				return err
			}
			out, err := c.StopCoordinator(ctx, directory(p), vibest.StopCoordinatorParams{Runtime: s.Runtime, Address: string(address)})
			if err != nil {
				return err
			}
			switch out.Result {
			case "stopped":
				return nil
			case "unsupported":
				return errors.New(out.Reason)
			case "moved":
				return errors.New(s.Name + " moved meanwhile; nothing was stopped")
			default:
				return errors.New(s.Name + " did not exit")
			}
		})
	}, nil)
}

func (a *App) focusedPlace() (coreID, cwd string) {
	coreID = a.coreState.Layout.CoreID
	if p := a.coreState.Layout.Pane(a.coreSelection.Pane); p != nil {
		coreID = p.Terminal.CoreID
		t := a.coreState.Terminals[p.Terminal.Address]
		if t.Foreground != nil && t.Foreground.CWD != "" {
			return coreID, t.Foreground.CWD
		}
		return coreID, t.CWD
	}
	return coreID, ""
}

func (a *App) projectPrompt() {
	_, cwd := a.focusedPlace()
	open := func(dir string) {
		if dir = filepath.Clean(dir); dir != "." && dir != "/" && filepath.IsAbs(dir) {
			a.projectOpenFolder(dir)
		}
	}
	pick := a.pickFolder
	if a.folderPicker != nil {
		pick = a.folderPicker
	}
	if pick(cwd, open) {
		return
	}
	a.ask("Project folder", cwd, false, open)
}

func (a *App) projectWorkspace(id string) string {
	for _, w := range a.coreState.Layout.Workspaces {
		if w.Project == id {
			return w.ID
		}
	}
	return ""
}

func directory(p vibest.Project) string {
	if p.Directory == nil {
		return ""
	}
	return *p.Directory
}

func addToProject(l *core.Layout, p vibest.Project, machine, tab string, pane core.Pane) error {
	for _, w := range l.Workspaces {
		if w.Project == p.ID {
			_, err := l.AddTab(w.ID, tab, pane)
			return err
		}
	}
	l.AddWorkspace(p.Name(), directory(p), machine, pane)
	l.Workspaces[len(l.Workspaces)-1].Project = p.ID
	l.Workspaces[len(l.Workspaces)-1].Tabs[0].Label = tab
	return nil
}

func (a *App) projectNewTerminal(p vibest.Project) {
	a.emptyProject = ""
	s := a.coreSession
	if s == nil {
		a.err = "Not connected to Core"
		return
	}
	o := core.TerminalRunParams{CWD: core.Optional(directory(p)), Keep: true, Labels: map[string]string{ProjectLabel: p.ID}}
	a.coreNavigation++
	intent := a.coreNavigation
	n := a.beginCoreCapture("", true)
	a.corePending = true
	a.coreSelect(nil)
	if a.navigationNote == "" {
		a.navigationNote = "Creating terminal; input paused"
	}
	a.coreRunCapture(s, intent, n, o, "", func(l *core.Layout, added core.Pane, record core.Terminal) error {
		return addToProject(l, p, "", "", added)
	})
}

func (a *App) projectSelect(p vibest.Project) { a.openProject(p, "") }

func (a *App) paneShowing(address string) string {
	var pane string
	for _, w := range a.coreState.Layout.Workspaces {
		for _, t := range w.Tabs {
			walkCorePanes(t.Root, func(p *core.Pane) {
				if pane == "" && p.Terminal.Address == address {
					pane = p.ID
				}
			})
		}
	}
	return pane
}

func (a *App) sessionOpen(p vibest.Project, r vibest.Row) {
	address, ok := a.sessionAddress(r.Session)
	if !ok {
		a.coreNavigate(func(*core.Selection, *core.Layout) error {
			return errors.New(r.Session.Name + " is not in this Core; its actions remain available here")
		})
		return
	}
	a.openProject(p, address)
}

func (a *App) projectSection(c *ui.Context) {
	th := a.th
	ui.Row(c.Key("projects-header")).FillWidth().AlignItems(ui.Center).Children(func() {
		ui.Text(c, "Projects").FontSize(th.FontSizeSmall).FontWeight(600).TextColor(th.Secondary).Grow(1).MinWidth(0).SingleLine().Margin(0, 0, 0, chrome.Step8)
		if a.iconButton(c.Key("new-project"), chrome.IconPlus, "New project").Clicked() {
			a.projectPrompt()
		}
	})
	if a.vibestNote != "" {
		ui.Text(c.Key("vibest-note"), a.vibestNote).FontSize(th.FontSizeSmall).TextColor(th.Danger).Margin(0, 0, 0, chrome.Step8)
	}
	for _, g := range a.vibestModel.Groups(a.sessionPinned) {
		a.projectHeader(c, g)
	}
}

func (a *App) projectHeader(c *ui.Context, g vibest.Group) {
	th, p := a.th, g.Project
	on := a.currentProject() == p.ID
	status := a.projectStatus(g)
	b := a.rowButton(c, "project/"+p.ID, on).FillWidth().Label("project: " + p.Name()).Description(statusDescription(status)).Tooltip(directory(p))
	ink := a.rowInk(th.Row.Pick(on, b.Hovered(), a.windowFocused))
	b.Children(func() {
		ui.Text(c, p.Name()).FontSize(th.Row.FontSize).FontWeight(600).TextColor(ink).Grow(1).MinWidth(0).SingleLine()
		sessionActivity(c, th, status)
	})
	if b.Clicked() {
		a.projectSelect(p)
	}
	b.ContextMenu(func(m *ui.Menu) {
		if m.Item("Open").Chosen() {
			a.projectSelect(p)
		}
		if m.Item("Start main agent").Disabled(directory(p) == "" || a.mainRunning(p)).Chosen() {
			a.projectStartMain(p)
		}
		if m.Item("New terminal").Disabled(directory(p) == "").Chosen() {
			a.projectNewTerminal(p)
		}
		for _, r := range g.Rows {
			m.Submenu(r.Session.Name, func(m *ui.Menu) { a.sessionMenu(m, p, r) })
		}
	})
}

func (a *App) sessionMenu(m *ui.Menu, p vibest.Project, r vibest.Row) {
	s := r.Session
	if m.Item("Open").Chosen() {
		a.sessionOpen(p, r)
	}
	if address, ok := a.sessionAddress(s); ok {
		label, value := "Pin", "1"
		if a.sessionPinned(s) {
			label, value = "Unpin", ""
		}
		if m.Item(label).Chosen() {
			a.writeLabel(address, pinnedLabel, value)
		}
	}
	if r.Main {
		if m.Item("Stop…").Chosen() {
			a.sessionStop(p, s)
		}
	} else if m.Item("Archive…").Chosen() {
		a.sessionArchive(s)
	}
}

func (a *App) projectStatus(g vibest.Group) string {
	status := "idle"
	rank := map[string]int{"done": 1, "working": 2, "blocked": 3, "error": 4}
	for _, r := range g.Rows {
		if next := a.sessionStatus(r.Session); rank[next] > rank[status] {
			status = next
		}
	}
	return status
}

func statusDescription(status string) string {
	switch status {
	case "working":
		return "Working"
	case "blocked":
		return "Waiting for you"
	case "error":
		return "Error"
	case "done":
		return "Unseen done"
	default:
		return "Idle"
	}
}

func sessionActivity(c *ui.Context, th *chrome.Theme, status string) {
	switch status {
	case "working":
		loading.Ring(c.Key("activity"), loading.Options{Size: th.Slot, Color: th.Working}).PassThrough().Label("session activity: working")
	case "blocked":
		ui.Row(c.Key("activity")).Size(th.Slot, th.Slot).Shrink(0).Center().PassThrough().Label("session activity: waiting").Children(func() {
			ui.Box(c).Size(8, 8).Radius(4).Background(th.Blocked)
		})
	case "error":
		ui.Text(c.Key("activity"), "!").Size(th.Slot, th.Slot).TextColor(th.Danger).PassThrough().Label("session activity: error")
	case "done":
		ui.Icon(c.Key("activity"), chrome.IconCheck).Size(th.Slot, th.Slot).Shrink(0).TextColor(th.Done).PassThrough().Label("session activity: done")
	default:
		ui.Box(c.Key("activity")).Size(th.Slot, th.Slot).Shrink(0).PassThrough()
	}
}
