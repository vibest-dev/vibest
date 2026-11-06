package app

import (
	"strings"
	"vibest-desktop/internal/presentation"

	"vibest-desktop/internal/core"
)

type machine struct {
	coreWorkspace string
	coreRecords   map[string]core.Terminal
	coreRefs      map[string]core.TerminalRef
	coreSeen      map[core.TerminalRef]uint64
	remote        *presentation.Machine
	version       string
	snap          *presentation.Snapshot
	connected     bool
	err           string
}

func newMachine(remote *presentation.Machine) *machine { return &machine{remote: remote} }

func (m *machine) id() string {
	if m.remote == nil {
		return ""
	}
	return m.remote.ID
}

func (m *machine) label() string {
	if m.remote == nil {
		return "Local"
	}
	return m.remote.Label
}

func (a *App) machineByID(id string) *machine {
	for _, m := range a.machines {
		if m.id() == id {
			return m
		}
	}
	return nil
}

func (a *App) ShowNotice(id string) {
	machine, pane, ok := strings.Cut(id, "/")
	if !ok {
		machine, pane = "", id
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if m := a.machineByID(machine); m != nil {
		if _, exists := m.coreRefs[pane]; !exists {
			return
		}
		a.showPaneOf(m, pane)
		if a.dialog == nil && a.nativeDialog == nil {
			a.returnFocus = true
		}
	}
}

func (a *App) showPaneOf(m *machine, pane string) {
	a.ShowPane(pane)
}

func (a *App) showWorkspaceOf(m *machine, ws string) {
	a.SelectWorkspace(ws)
}
