package app

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/vibest"
)

type projectTerminal struct {
	ref  core.TerminalRef
	name string
}

func (a *App) currentProject() string {
	if a.emptyProject != "" {
		return a.emptyProject
	}
	for _, w := range a.coreState.Layout.Workspaces {
		if w.ID == a.coreSelection.Workspace {
			return w.Project
		}
	}
	return ""
}

func (a *App) terminalProject(address string) string {
	for _, s := range a.vibestModel.Sessions {
		if at, ok := a.sessionAddress(s); ok && at == address {
			return s.ProjectID
		}
	}
	t := a.coreState.Terminals[address]
	for _, key := range []string{ProjectLabel, "herdr.space"} {
		if id := t.Labels[key]; id != "" {
			return id
		}
	}
	for _, w := range a.coreState.Layout.Workspaces {
		for _, tab := range w.Tabs {
			found := false
			walkCorePanes(tab.Root, func(p *core.Pane) { found = found || p.Terminal.Address == address })
			if found {
				return w.Project
			}
		}
	}
	return ""
}

func (a *App) projectTerminals(p vibest.Project) []projectTerminal {
	var out []projectTerminal
	seen := map[string]bool{}
	add := func(address, name string) {
		if seen[address] || a.coreSession == nil {
			return
		}
		ref, err := a.coreSession.Ref(address)
		if err != nil {
			return
		}
		seen[address] = true
		out = append(out, projectTerminal{ref, name})
	}
	for _, g := range a.vibestModel.Groups(a.sessionPinned) {
		if g.Project.ID != p.ID {
			continue
		}
		for _, r := range g.Rows {
			if address, ok := a.sessionAddress(r.Session); ok {
				add(address, r.Session.Name)
			}
		}
	}
	var addresses []string
	for address := range a.coreState.Terminals {
		if a.terminalProject(address) == p.ID {
			addresses = append(addresses, address)
		}
	}
	sort.Slice(addresses, func(i, j int) bool {
		a, b := a.coreState.Terminals[addresses[i]], a.coreState.Terminals[addresses[j]]
		if a.Labels["herdr.tab"] != b.Labels["herdr.tab"] {
			return a.Labels["herdr.tab"] < b.Labels["herdr.tab"]
		}
		return addresses[i] < addresses[j]
	})
	for _, address := range addresses {
		t := a.coreState.Terminals[address]
		name := t.Title
		if name == "" {
			name = t.Labels["herdr.tab"]
		}
		if name == "" {
			name = address
		}
		add(address, name)
	}
	return out
}

func paneForRef(l *core.Layout, ref core.TerminalRef) (*core.Pane, string) {
	for _, w := range l.Workspaces {
		for _, tab := range w.Tabs {
			var found *core.Pane
			walkCorePanes(tab.Root, func(p *core.Pane) {
				if p.Terminal == ref {
					found = p
				}
			})
			if found != nil {
				return found, w.Project
			}
		}
	}
	return nil, ""
}

func (a *App) openProject(p vibest.Project, address string) {
	a.openProjectTerminals(p, a.projectTerminals(p), address)
}

func (a *App) openProjectTerminals(p vibest.Project, entries []projectTerminal, address string) {
	if len(entries) == 0 {
		a.cancelCoreCapture()
		a.coreNavigation++
		a.coreBlocked = true
		a.coreSelect(nil)
		a.emptyProject = p.ID
		return
	}
	panes := make([]core.Pane, len(entries))
	target, edit := 0, false
	for i, e := range entries {
		pane, project := paneForRef(&a.coreState.Layout, e.ref)
		if pane == nil {
			panes[i] = core.NewPane(e.ref)
		} else {
			panes[i] = *pane
		}
		edit = edit || pane == nil || project != p.ID
		if e.ref.Address == address || address == "" && a.currentProject() == p.ID && panes[i].ID == a.coreSelection.Pane {
			target = i
		}
	}
	if address != "" && entries[target].ref.Address != address {
		a.coreNavigate(func(*core.Selection, *core.Layout) error {
			return errors.New("Terminal is not available in this project")
		})
		return
	}
	a.emptyProject = ""
	if !edit {
		a.ShowPane(panes[target].ID)
		return
	}
	s := a.coreSession
	a.coreNavigation++
	intent := a.coreNavigation
	var n *coreCapture
	if entries[target].ref.CoreID == a.coreState.Layout.CoreID {
		n = a.beginCoreCapture("", true)
	} else {
		a.cancelCoreCapture()
		a.coreBlocked = true
	}
	a.corePending = true
	a.coreSelect(nil)
	ref, id := entries[target].ref, panes[target].ID
	program := a.coreState.Programs[ref.Address]
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		err := s.Edit(ctx, func(l *core.Layout) error {
			for i, e := range entries {
				old, project := paneForRef(l, e.ref)
				if old != nil && project == p.ID {
					continue
				}
				if old != nil {
					if old.ID != panes[i].ID {
						return core.ErrOwnership
					}
					if err := l.RemovePane(old.ID); err != nil {
						return err
					}
				}
				machine := ""
				if e.ref.CoreID != l.CoreID {
					machine, _, _ = strings.Cut(e.ref.Address, "/")
				}
				if err := addToProject(l, p, machine, e.name, panes[i]); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			a.failCoreCreation(s, intent, "Could not open project: "+err.Error())
			return
		}
		a.mu.Lock()
		if a.coreSession == s && a.coreNavigation == intent && a.coreCapture == n {
			a.projectOpened = func() {
				if a.coreSession != s || a.coreNavigation != intent || a.coreCapture != n {
					return
				}
				a.coreApply(s)
				if a.coreCapture != n || a.coreState.Programs[ref.Address] != program {
					a.cancelCoreCapture()
					return
				}
				if err := a.coreSelection.SelectPane(&a.coreState.Layout, id); err != nil {
					a.coreOperationNote = "Could not open project: " + err.Error()
					a.cancelCoreCapture()
					return
				}
				if n != nil {
					n.pane, n.ref, n.program, n.creating = id, ref, program, false
				}
				a.corePending = false
				a.coreChrome()
				a.returnFocus = a.dialog == nil && a.nativeDialog == nil
			}
		}
		a.mu.Unlock()
		a.invalidate()
	}()
}

type projectTabEntry struct {
	name, address string
	session       *vibest.Row
}

func (a *App) projectTabEntries(p vibest.Project) []projectTabEntry {
	var entries []projectTabEntry
	shown := map[string]bool{}
	for _, g := range a.vibestModel.Groups(a.sessionPinned) {
		if g.Project.ID != p.ID {
			continue
		}
		for _, r := range g.Rows {
			address, _ := a.sessionAddress(r.Session)
			shown[address] = true
			entries = append(entries, projectTabEntry{r.Session.Name, address, &r})
		}
	}
	for _, e := range a.projectTerminals(p) {
		if !shown[e.ref.Address] {
			entries = append(entries, projectTabEntry{e.name, e.ref.Address, nil})
		}
	}
	return entries
}

func (a *App) openProjectEntry(p vibest.Project, e projectTabEntry) {
	if e.session != nil {
		a.sessionOpen(p, *e.session)
	} else {
		a.openProject(p, e.address)
	}
}

func (a *App) projectTabs(c *ui.Context) bool {
	p, ok := a.vibestModel.Projects[a.currentProject()]
	if !ok {
		return false
	}
	for _, e := range a.projectTabEntries(p) {
		key, status := "terminal/"+e.address, a.coreState.Terminals[e.address].Activity()
		if e.session != nil {
			key, status = "session/"+e.session.Session.ID, a.sessionStatus(e.session.Session)
		}
		a.projectTab(c, key, e.name, e.address, status, func() { a.openProjectEntry(p, e) }, func(m *ui.Menu) {
			if e.session != nil {
				a.sessionMenu(m, p, *e.session)
				return
			}
			if m.Item("Open").Chosen() {
				a.openProject(p, e.address)
			}
			if id := a.paneShowing(e.address); id != "" {
				was := a.menuPane
				a.menuPane = id
				a.paneMenu(m)
				a.menuPane = was
			}
		})
	}
	if directory(p) != "" && a.iconButton(c.Key("project-new-terminal/"+p.ID), chrome.IconPlus, "New terminal in "+p.Name()).Clicked() {
		a.projectNewTerminal(p)
	}
	return true
}

func (a *App) projectTabShortcuts(p vibest.Project, on func(ui.Modifiers, ui.Key, func())) {
	entries := a.projectTabEntries(p)
	for i, key := range []ui.Key{ui.Key1, ui.Key2, ui.Key3, ui.Key4, ui.Key5, ui.Key6, ui.Key7, ui.Key8, ui.Key9} {
		if i < len(entries) {
			on(ui.Cmd, key, func() { a.openProjectEntry(p, entries[i]) })
		}
	}
	pane := a.coreState.Layout.Pane(a.coreSelection.Pane)
	if pane == nil || a.emptyProject != "" || len(entries) < 2 {
		return
	}
	for i, e := range entries {
		if e.address != pane.Terminal.Address {
			continue
		}
		on(ui.Cmd|ui.Shift, ui.KeyBracketLeft, func() { a.openProjectEntry(p, entries[(i+len(entries)-1)%len(entries)]) })
		on(ui.Cmd|ui.Shift, ui.KeyBracketRight, func() { a.openProjectEntry(p, entries[(i+1)%len(entries)]) })
		break
	}
}

func (a *App) projectTab(c *ui.Context, key, name, address, status string, open func(), menu func(*ui.Menu)) {
	th := a.th
	pane := a.coreState.Layout.Pane(a.coreSelection.Pane)
	on := a.emptyProject == "" && pane != nil && pane.Terminal.Address == address
	b := ui.ButtonBase(c.Key(key)).Role(ui.RoleTab).AccessSelected(on).Label("session: "+name).Description(statusDescription(status)).MinWidth(th.TabWidth).MaxWidth(th.TabWidth).Height(th.IconButton).Padding(0, 10).Gap(6).KeepFocus()
	st := th.Tab.Pick(on, b.Hovered(), a.windowFocused)
	st.Apply(b)
	b.Children(func() {
		ui.Text(c, name).FontSize(th.Tab.FontSize).FontWeight(st.Weight).TextColor(a.rowInk(st)).Grow(1).MinWidth(0).SingleLine()
		sessionActivity(c, th, status)
	})
	if b.Clicked() {
		open()
	}
	b.ContextMenu(menu)
}
