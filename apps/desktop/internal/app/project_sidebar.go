package app

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"github.com/egoist/mygo/plugins/loading"
	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/project"
)

type projectWindow struct {
	projects      project.File
	projectEpoch  uint64
	projectSeq    uint64
	foldedProject map[string]bool
	folderPicker  func(start string, run func(string)) bool
}

func (a *App) projectReload() {
	c, s := a.coreClient, a.coreSession
	if c == nil {
		return
	}
	a.projectSeq++
	seq := a.projectSeq
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		f, err := project.Load(ctx, c.Call)
		if err != nil {
			a.coreNote(s, "Projects: "+err.Error())
			return
		}
		a.mu.Lock()
		if a.coreSession == s && a.projectSeq == seq {
			a.projects = f
		}
		a.mu.Unlock()
		a.invalidate()
	}()
}

func (a *App) projectDo(change func(context.Context, project.Call) (project.File, error)) {
	c, s := a.coreClient, a.coreSession
	if c == nil {
		a.err = "Not connected to Core"
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		f, err := change(ctx, c.Call)
		if err != nil {
			a.coreNote(s, "Projects: "+err.Error())
			return
		}
		a.mu.Lock()
		if a.coreSession == s {
			if f.Schema != 0 {
				a.projectSeq++
				a.projects = f
			}
		}
		a.mu.Unlock()
		a.invalidate()
	}()
}

func (a *App) projectCreate(p project.Project) {
	a.projectDo(func(ctx context.Context, call project.Call) (project.File, error) {
		return project.Create(ctx, call, p)
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
	coreID, cwd := a.focusedPlace()
	if coreID == a.coreState.Layout.CoreID {
		pick := a.pickFolder
		if a.folderPicker != nil {
			pick = a.folderPicker
		}
		if pick(cwd, func(dir string) {
			if dir = filepath.Clean(dir); dir != "." && dir != "/" {
				a.projectCreate(project.Project{ID: project.NewID(), Name: filepath.Base(dir), Core: coreID, CWD: dir})
			}
		}) {
			return
		}
	}
	a.ask("New project", "", false, func(name string) {
		if name == "" {
			return
		}
		a.ask("Project directory", cwd, false, func(dir string) {
			a.projectCreate(project.Project{ID: project.NewID(), Name: name, Core: coreID, CWD: dir})
		})
	})
}

func (a *App) projectWorkspace(id string) string {
	for _, w := range a.coreState.Layout.Workspaces {
		if w.Project == id {
			return w.ID
		}
	}
	return ""
}

func addToProject(l *core.Layout, p project.Project, machine, cwd, tab string, pane core.Pane) error {
	for _, w := range l.Workspaces {
		if w.Project == p.ID {
			_, err := l.AddTab(w.ID, tab, pane)
			return err
		}
	}
	l.AddWorkspace(p.Name, cwd, machine, pane)
	l.Workspaces[len(l.Workspaces)-1].Project = p.ID
	return nil
}

func (a *App) projectNewTerminal(p project.Project) {
	s := a.coreSession
	if s == nil {
		a.err = "Not connected to Core"
		return
	}
	o := project.RunOptions(p, core.RunOptions{})
	machine := ""
	if o.On != "" && o.On != a.coreState.Layout.CoreID {
		for _, m := range a.coreState.Machines {
			if m.ID == o.On && m.State == "connected" {
				machine = m.Name
			}
		}
		if machine == "" {
			a.navigationNote = "Project machine is offline"
			return
		}
	}
	a.coreNavigation++
	intent := a.coreNavigation
	n := a.beginCoreCapture("", true)
	if o.On != "" && o.On != a.coreState.Layout.CoreID {
		a.cancelCoreCapture()
	}
	a.corePending = true
	a.coreSelect(nil)
	if a.navigationNote == "" {
		a.navigationNote = "Creating terminal; input paused"
	}
	a.coreRunCapture(s, intent, n, o, "", func(l *core.Layout, added core.Pane, record core.Terminal) error {
		return addToProject(l, p, machine, record.CWD, "", added)
	})
}

func (a *App) projectSelect(p project.Project) {
	if ws := a.projectWorkspace(p.ID); ws != "" {
		a.SelectWorkspace(ws)
		a.returnFocus = true
		return
	}
	a.navigationNote = p.Name + " has no terminals yet; use + to start one"
}
func (a *App) projectRename(id, name string) {
	a.projectDo(func(ctx context.Context, call project.Call) (project.File, error) {
		return project.Rename(ctx, call, id, name)
	})
}
func (a *App) projectDelete(id string) {
	a.projectDo(func(ctx context.Context, call project.Call) (project.File, error) {
		return project.Delete(ctx, call, id)
	})
}

func (a *App) projectMember(address, id string, member bool) {
	a.projectDo(func(ctx context.Context, call project.Call) (project.File, error) {
		return project.File{}, project.SetMember(ctx, call, address, id, member)
	})
}

func (a *App) focusedAddress() string {
	if p := a.coreState.Layout.Pane(a.coreSelection.Pane); p != nil {
		return p.Terminal.Address
	}
	return ""
}

func (a *App) projectOpen(r project.Row, owner *project.Project) {
	var pane string
	for _, w := range a.coreState.Layout.Workspaces {
		for _, t := range w.Tabs {
			walkCorePanes(t.Root, func(p *core.Pane) {
				if pane == "" && p.Terminal.Address == r.Address {
					pane = p.ID
				}
			})
		}
	}
	if pane != "" {
		a.coreNavigate(func(sel *core.Selection, l *core.Layout) error { return sel.SelectPane(l, pane) })
		return
	}
	if a.coreSession == nil {
		a.err = "Not connected to Core"
		return
	}
	ref, err := a.coreSession.Ref(r.Address)
	if err != nil {
		a.navigationNote = "Cannot open " + r.Address + ": machine unavailable"
		return
	}
	added := core.NewPane(ref)
	a.coreEditAndFollow(added.ID, func(l *core.Layout) error {
		if owner != nil {
			return addToProject(l, *owner, r.Machine, r.Terminal.CWD, r.Title(), added)
		}
		l.AddWorkspace(r.Title(), r.Terminal.CWD, r.Machine, added)
		return nil
	})
}

func (a *App) projectSection(c *ui.Context) {
	th := a.th
	groups := project.Build(a.projects, a.coreState.Terminals, a.coreState.Machines)
	focused := a.focusedAddress()
	local := ""
	if a.coreClient != nil {
		local = a.coreClient.Hello().Core.Name
	}
	ui.Row(c).Key("projects-header").FillWidth().AlignItems(ui.Center).Children(func() {
		ui.Text(c, "Projects").FontSize(th.FontSizeSmall).FontWeight(600).TextColor(th.Secondary).Grow(1).MinWidth(0).SingleLine().Margin(0, 0, 0, chrome.Step8)
		if a.iconButton(c.Key("new-project"), chrome.IconPlus, "New project").Clicked() {
			a.projectPrompt()
		}
	})
	for _, g := range groups {
		if g.Project == nil && (len(g.Rows) == 0 || len(a.projects.Projects) == 0) {
			continue
		}
		a.projectHeader(c, g, groups)
		if g.Project != nil && a.foldedProject[g.Project.ID] || g.Project == nil && a.foldedProject[""] {
			continue
		}
		for _, r := range g.Rows {
			a.projectRow(c, g, r, groups, focused, local)
		}
	}
}

func (a *App) projectHeader(c *ui.Context, g project.Group, groups []project.Group) {
	th := a.th
	id := ""
	if g.Project != nil {
		id = g.Project.ID
	}
	folded := a.foldedProject[id]
	ui.Row(c).Key("project-header/" + id).FillWidth().Gap(2).AlignItems(ui.Center).Children(func() {
		action, glyph := "Collapse project: ", "▾"
		if folded {
			action, glyph = "Expand project: ", "▸"
		}
		d := ui.ButtonBase(c).Key("project-disclosure/"+id).Size(th.IconButton, th.IconButton).Padding(0).Radius(th.Radius).KeepFocus().Role(ui.RoleDisclosure).Expanded(!folded).Label(action + g.Name()).Tooltip(action + g.Name())
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
		on := g.Project != nil && a.projectWorkspace(id) != "" && a.projectWorkspace(id) == a.coreSelection.Workspace
		b := a.rowButton(c, "project/"+id, on).Grow(1).MinWidth(0).Label("project: " + g.Name())
		ink := a.rowInk(th.Row.Pick(on, b.Hovered(), a.windowFocused))
		b.Children(func() {
			ui.Text(c, g.Name()).FontSize(th.Row.FontSize).FontWeight(600).TextColor(ink).Grow(1).MinWidth(0).SingleLine()
			if g.Waiting > 0 {
				ui.Text(c, fmt.Sprintf("%d waiting", g.Waiting)).FontSize(th.FontSizeSmall).TextColor(th.Blocked).Shrink(0).SingleLine()
			}
			if g.Working > 0 {
				ui.Text(c, fmt.Sprintf("%d working", g.Working)).FontSize(th.FontSizeSmall).TextColor(th.Working).Shrink(0).SingleLine()
			}
		})
		if g.Project != nil {
			p := *g.Project
			if b.Clicked() {
				a.projectSelect(p)
			}
			b.ContextMenu(func(m *ui.Menu) {
				if m.Item("Add focused terminal").Chosen() {
					if addr := a.focusedAddress(); addr != "" {
						a.projectMember(addr, p.ID, true)
					} else {
						a.navigationNote = "No focused terminal"
					}
				}
				if m.Item("Rename").Chosen() {
					a.ask("Rename project", p.Name, false, func(v string) {
						if v != "" {
							a.projectRename(p.ID, v)
						}
					})
				}
				if m.Item("Delete project").Chosen() {
					a.ask("Delete project "+p.Name+"? Its terminals become Unassigned.", "", true, func(string) { a.projectDelete(p.ID) })
				}
			})
			if a.iconButton(c.Key("project-new-terminal/"+id), chrome.IconPlus, "New terminal in "+p.Name).Clicked() {
				a.projectNewTerminal(p)
				a.returnFocus = true
			}
		}
	})
}

func (a *App) projectRow(c *ui.Context, g project.Group, r project.Row, groups []project.Group, focused, local string) {
	th := a.th
	on := r.Address == focused
	key := "project-row/" + g.Name() + "/" + r.Address
	ui.Row(c).FillWidth().Padding(0, 0, 0, th.GroupIndent*float32(r.Depth+1)).Children(func() {
		b := a.rowButton(c, key, on).Grow(1).MinWidth(0).Label("terminal: " + r.Title())
		st := th.Row.Pick(on, b.Hovered(), a.windowFocused)
		ink := a.rowInk(st)
		if r.Offline {
			ink = th.Tertiary
		}
		machine := r.Machine
		if machine == "" {
			machine = local
		}
		b.Children(func() {
			switch {
			case r.Offline:
				ui.Box(c.Key("activity")).Size(th.Slot, th.Slot).Shrink(0).PassThrough()
			case r.Blocked:
				ui.Row(c.Key("activity")).Size(th.Slot, th.Slot).Shrink(0).Center().PassThrough().Label("terminal activity: waiting").Children(func() {
					ui.Box(c).Size(8, 8).Radius(4).Background(th.Blocked)
				})
			default:
				projectActivity(c, th, r.Activity)
			}
			ui.Column(c).Grow(1).MinWidth(0).Children(func() {
				ui.Text(c, r.Title()).FontSize(th.Row.FontSize).FontWeight(st.Weight).TextColor(ink).SingleLine()
				if r.Blocked && !r.Offline {
					ui.Text(c, waitingText(r.Reason)).FontSize(th.FontSizeSmall).TextColor(th.Blocked).SingleLine()
				}
			})
			if machine != "" {
				ui.Text(c, machine).FontSize(th.FontSizeSmall).TextColor(th.Secondary).Shrink(0).SingleLine()
			}
		})
		if r.Offline {
			b.Tooltip("Machine is offline")
		}
		if b.Clicked() {
			a.projectOpen(r, g.Project)
			a.returnFocus = true
		}
		b.ContextMenu(func(m *ui.Menu) {
			if r.Member && g.Project != nil && m.Item("Remove from "+g.Project.Name).Chosen() {
				a.projectMember(r.Address, g.Project.ID, false)
			}
			if g.Project == nil {
				for _, o := range groups {
					if o.Project != nil && m.Item("Add to "+o.Project.Name).Chosen() {
						a.projectMember(r.Address, o.Project.ID, true)
					}
				}
			}
		})
	})
}

func projectActivity(c *ui.Context, th *chrome.Theme, status string) {
	switch status {
	case "working":
		loading.Ring(c.Key("activity"), loading.Options{Size: th.Slot, Color: th.Working}).PassThrough().Label("terminal activity: working")
	case "done":
		ui.Icon(c.Key("activity"), chrome.IconCheck).Size(th.Slot, th.Slot).Shrink(0).TextColor(th.Done).PassThrough().Label("terminal activity: done")
	default:
		ui.Box(c.Key("activity")).Size(th.Slot, th.Slot).Shrink(0).PassThrough()
	}
}

func waitingText(kind string) string {
	switch kind {
	case "permission":
		return "Needs permission"
	case "question":
		return "Has a question"
	case "auth":
		return "Needs sign-in"
	}
	return "Waiting for you"
}
