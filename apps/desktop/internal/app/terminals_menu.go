package app

import (
	"github.com/egoist/mygo/ui"
	"sort"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/vibest"
)

func (a *App) terminalsMenu(m *ui.Menu) {
	if m.Item("New terminal").Chosen() {
		a.NewWorkspace()
	}
	for i, w := range a.coreState.Layout.Workspaces {
		if _, known := a.vibestModel.Projects[w.Project]; known {
			continue
		}
		m.Submenu(label(w.Label, i+1), func(m *ui.Menu) {
			if m.Item("Open").Chosen() {
				a.SelectWorkspace(w.ID)
			}
			a.workspaceMenu(m, w)
		})
	}
	var addresses []string
	for address, record := range a.coreState.Terminals {
		if _, known := a.vibestModel.Projects[a.terminalProject(address)]; !known && a.paneShowing(address) == "" && record.State == "live" {
			addresses = append(addresses, address)
		}
	}
	sort.Strings(addresses)
	for _, address := range addresses {
		if m.Item("Open " + address).Chosen() {
			a.openTerminal(address)
		}
	}
}

func (a *App) openTerminal(address string) {
	if pane := a.paneShowing(address); pane != "" {
		a.ShowPane(pane)
		return
	}
	if a.coreSession == nil {
		return
	}
	ref, err := a.coreSession.Ref(address)
	if err != nil {
		a.coreNavigate(func(*core.Selection, *core.Layout) error { return err })
		return
	}
	a.openProjectTerminals(vibest.Project{}, []projectTerminal{{ref, address}}, address)
}

func (a *App) workspaceMenu(m *ui.Menu, w core.Workspace) {
	if m.Item("Refresh Git metadata").Chosen() {
		a.RefreshRepository(w.ID)
	}
	if m.Item("Rename").Chosen() {
		a.ask("Rename", w.Label, false, func(v string) { a.RenameWorkspace(w.ID, v) })
	}
	if w.Repository != "" && !w.Linked {
		if m.Item("Close group").Chosen() {
			a.CloseWorkspaceGroup(w.ID)
		}
		if m.Item("New worktree").Chosen() {
			a.ask("New worktree", "", false, func(v string) {
				if v != "" {
					a.CreateWorktree(w.ID, v)
				}
			})
		}
		if m.Item("Open worktree...").Chosen() {
			a.ask("Open worktree", "", false, func(v string) {
				if v != "" {
					a.OpenWorktree(w.ID, v)
				}
			})
		}
	} else {
		if m.Item("Close").Chosen() {
			a.CloseWorkspace(w.ID)
		}
		if w.Linked && m.Item("Delete worktree checkout...").Chosen() {
			a.RemoveWorktree(w.ID)
		}
	}
}
