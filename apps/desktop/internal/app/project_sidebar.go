package app

import (
	"context"
	"errors"
	"fmt"
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
	foldedProject map[string]bool
	folderPicker  func(start string, run func(string)) bool
}

func newProjectWindow() projectWindow {
	return projectWindow{vibestSocket: vibest.SocketPath(), dialVibest: vibest.Dial}
}

func (a *App) vibestDo(action func(context.Context, *vibest.Client) error) {
	socket, dial := a.vibestSocket, a.dialVibest
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
	return nil
}

func (a *App) projectNewTerminal(p vibest.Project) {
	s := a.coreSession
	if s == nil {
		a.err = "Not connected to Core"
		return
	}
	o := core.RunOptions{CWD: directory(p), Keep: true, Labels: map[string]string{ProjectLabel: p.ID}}
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

func (a *App) projectSelect(p vibest.Project) {
	if ws := a.projectWorkspace(p.ID); ws != "" {
		a.SelectWorkspace(ws)
		a.returnFocus = true
		return
	}
	a.navigationNote = p.Name() + " has no terminals yet; use + to start one"
}

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

func (a *App) sessionOpen(g vibest.Group, r vibest.Row) {
	address, ok := r.Session.CoreAddress()
	if !ok {
		a.navigationNote = r.Session.Name + " runs in " + r.Session.Runtime + "; only herdr-core terminals open here"
		return
	}
	if pane := a.paneShowing(address); pane != "" {
		a.coreNavigate(func(sel *core.Selection, l *core.Layout) error { return sel.SelectPane(l, pane) })
		return
	}
	if a.coreSession == nil {
		a.err = "Not connected to Core"
		return
	}
	ref, err := a.coreSession.Ref(address)
	if err != nil {
		a.navigationNote = "Cannot open " + r.Session.Name + ": machine unavailable"
		return
	}
	machine := ""
	if m := r.Session.Address.Machine; m != "" && m != vibest.LocalMachine {
		machine = m
	}
	added := core.NewPane(ref)
	a.coreEditAndFollow(added.ID, func(l *core.Layout) error {
		return addToProject(l, g.Project, machine, r.Session.Name, added)
	})
}

func (a *App) projectSection(c *ui.Context) {
	th := a.th
	ui.Row(c).Key("projects-header").FillWidth().AlignItems(ui.Center).Children(func() {
		ui.Text(c, "Projects").FontSize(th.FontSizeSmall).FontWeight(600).TextColor(th.Secondary).Grow(1).MinWidth(0).SingleLine().Margin(0, 0, 0, chrome.Step8)
		if a.iconButton(c.Key("new-project"), chrome.IconPlus, "New project").Clicked() {
			a.projectPrompt()
		}
	})
	if a.vibestNote != "" {
		ui.Text(c.Key("vibest-note"), a.vibestNote).FontSize(th.FontSizeSmall).TextColor(th.Danger).Margin(0, 0, 0, chrome.Step8)
	}
	focused := a.focusedAddress()
	for _, g := range a.vibestModel.Groups() {
		a.projectHeader(c, g)
		if a.foldedProject[g.Project.ID] {
			continue
		}
		for _, r := range g.Rows {
			a.sessionRow(c, g, r, focused)
		}
	}
}

func (a *App) projectHeader(c *ui.Context, g vibest.Group) {
	th := a.th
	p := g.Project
	id := p.ID
	folded := a.foldedProject[id]
	ui.Row(c).Key("project-header/" + id).FillWidth().Gap(2).AlignItems(ui.Center).Children(func() {
		action, glyph := "Collapse project: ", "▾"
		if folded {
			action, glyph = "Expand project: ", "▸"
		}
		d := ui.ButtonBase(c).Key("project-disclosure/"+id).Size(th.IconButton, th.IconButton).Padding(0).Radius(th.Radius).KeepFocus().Role(ui.RoleDisclosure).Expanded(!folded).Label(action + p.Name()).Tooltip(action + p.Name())
		if d.Hovered() {
			d.Background(th.Row.Hover.Background)
		}
		d.Children(func() { paintMark(c, th, glyph, th.Secondary) })
		if d.Clicked() {
			if a.foldedProject == nil {
				a.foldedProject = map[string]bool{}
			}
			a.foldedProject[id] = !folded
		}
		on := a.projectWorkspace(id) != "" && a.projectWorkspace(id) == a.coreSelection.Workspace
		b := a.rowButton(c, "project/"+id, on).Grow(1).MinWidth(0).Label("project: " + p.Name()).Tooltip(directory(p))
		ink := a.rowInk(th.Row.Pick(on, b.Hovered(), a.windowFocused))
		b.Children(func() {
			ui.Text(c, p.Name()).FontSize(th.Row.FontSize).FontWeight(600).TextColor(ink).Grow(1).MinWidth(0).SingleLine()
			if g.Waiting > 0 {
				ui.Text(c, fmt.Sprintf("%d waiting", g.Waiting)).FontSize(th.FontSizeSmall).TextColor(th.Blocked).Shrink(0).SingleLine()
			}
			if g.Working > 0 {
				ui.Text(c, fmt.Sprintf("%d working", g.Working)).FontSize(th.FontSizeSmall).TextColor(th.Working).Shrink(0).SingleLine()
			}
		})
		if b.Clicked() {
			a.projectSelect(p)
		}
		if a.iconButton(c.Key("project-new-terminal/"+id), chrome.IconPlus, "New terminal in "+p.Name()).Clicked() {
			a.projectNewTerminal(p)
			a.returnFocus = true
		}
	})
}

func (a *App) focusedAddress() string {
	if p := a.coreState.Layout.Pane(a.coreSelection.Pane); p != nil {
		return p.Terminal.Address
	}
	return ""
}

func (a *App) sessionRow(c *ui.Context, g vibest.Group, r vibest.Row, focused string) {
	th := a.th
	s := r.Session
	address, inCore := s.CoreAddress()
	on := inCore && address == focused
	ui.Row(c).FillWidth().Padding(0, 0, 0, th.GroupIndent*float32(r.Depth+1)).Children(func() {
		b := a.rowButton(c, "session/"+s.ID, on).Grow(1).MinWidth(0).Label("session: " + s.Name)
		st := th.Row.Pick(on, b.Hovered(), a.windowFocused)
		ink := a.rowInk(st)
		if !inCore {
			ink = th.Tertiary
		}
		weight := st.Weight
		if r.Main {
			weight = 600
		}
		b.Children(func() {
			sessionActivity(c, th, s.Status)
			ui.Column(c).Grow(1).MinWidth(0).Children(func() {
				ui.Text(c, s.Name).FontSize(th.Row.FontSize).FontWeight(weight).TextColor(ink).SingleLine()
				if s.Status == "blocked" {
					ui.Text(c, "Waiting for you").FontSize(th.FontSizeSmall).TextColor(th.Blocked).SingleLine()
				}
			})
			ui.Text(c, s.Harness).FontSize(th.FontSizeSmall).TextColor(th.Secondary).Shrink(0).SingleLine()
		})
		if s.Task != nil && *s.Task != "" {
			b.Tooltip(*s.Task)
		}
		if b.Clicked() {
			a.sessionOpen(g, r)
			a.returnFocus = true
		}
	})
}

func sessionActivity(c *ui.Context, th *chrome.Theme, status string) {
	switch status {
	case "working":
		loading.Ring(c.Key("activity"), loading.Options{Size: th.Slot, Color: th.Working}).PassThrough().Label("session activity: working")
	case "blocked":
		ui.Row(c.Key("activity")).Size(th.Slot, th.Slot).Shrink(0).Center().PassThrough().Label("session activity: waiting").Children(func() {
			ui.Box(c).Size(8, 8).Radius(4).Background(th.Blocked)
		})
	case "done":
		ui.Icon(c.Key("activity"), chrome.IconCheck).Size(th.Slot, th.Slot).Shrink(0).TextColor(th.Done).PassThrough().Label("session activity: done")
	default:
		ui.Box(c.Key("activity")).Size(th.Slot, th.Slot).Shrink(0).PassThrough()
	}
}
