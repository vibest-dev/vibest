package app

import (
	"slices"
	"strings"
)

type State struct {
	Connected      bool              `json:"connected"`
	Error          string            `json:"error"`
	Version        string            `json:"version"`
	Workspace      string            `json:"workspace"`
	Tab            string            `json:"tab"`
	FocusPane      string            `json:"focus_pane"`
	Workspaces     []string          `json:"workspaces"`
	Tabs           []string          `json:"tabs"`
	Grid           [2]int            `json:"grid"`
	Sized          bool              `json:"sized"`
	Panes          []PaneState       `json:"panes"`
	Popup          string            `json:"popup,omitempty"`
	Opened         string            `json:"opened,omitempty"`
	Notices        []notice          `json:"notices"`
	Calls          map[string]int    `json:"calls"`
	Statuses       map[string]string `json:"statuses"`
	Machine        string            `json:"machine"`
	Machines       []MachineState    `json:"machines"`
	Toast          string            `json:"toast,omitempty"`
	Closing        string            `json:"closing,omitempty"`
	Dialog         string            `json:"dialog,omitempty"`
	SidebarVisible bool              `json:"sidebar_visible"`
	SidebarWidth   float32           `json:"sidebar_width"`
}

type MachineState struct {
	ID         string   `json:"id"`
	Label      string   `json:"label"`
	Connected  bool     `json:"connected"`
	Error      string   `json:"error,omitempty"`
	Workspaces []string `json:"workspaces"`
}

type PaneState struct {
	ID             string `json:"id"`
	Focused        bool   `json:"focused"`
	X              int    `json:"x"`
	Y              int    `json:"y"`
	Cols           int    `json:"cols"`
	Rows           int    `json:"rows"`
	MouseReporting bool   `json:"mouse_reporting"`
	Text           string `json:"text"`
}

func (a *App) State() State {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := State{
		Connected:      a.connected,
		Error:          a.err,
		Version:        a.version,
		Opened:         a.opened,
		Notices:        append([]notice(nil), a.notices...),
		Calls:          map[string]int{},
		Statuses:       map[string]string{},
		Machine:        a.id(),
		Toast:          a.toast,
		SidebarVisible: a.sidebarVisible,
		SidebarWidth:   a.sideWidth,
	}
	s.Closing = strings.Join(a.coreClosing, ",")
	if d := a.dialog; d != nil {
		s.Dialog = strings.TrimSpace(d.title + " " + d.detail)
	}
	for _, m := range a.machines {
		ms := MachineState{ID: m.id(), Label: m.label(), Connected: m.connected, Error: m.err}
		if m.snap != nil {
			for _, ws := range m.snap.Workspaces {
				ms.Workspaces = append(ms.Workspaces, ws.ID)
			}
		}
		s.Machines = append(s.Machines, ms)
	}
	if a.snap != nil {
		s.Workspace, s.Tab, s.FocusPane = a.snap.FocusedWorkspaceID, a.snap.FocusedTabID, a.snap.FocusedPaneID
		for _, ws := range a.snap.Workspaces {
			s.Workspaces = append(s.Workspaces, ws.ID)
		}
		for _, t := range a.snap.TabsOf(s.Workspace) {
			s.Tabs = append(s.Tabs, t.ID)
		}
		for _, ag := range a.snap.Agents {
			s.Statuses[ag.PaneID] = ag.AgentStatus
		}
	}
	for id, v := range a.coreViews {
		if _, visible := a.coreBounds[id]; !visible {
			continue
		}
		cols, rows := v.VT.Size()
		r := a.coreBounds[id]
		s.Panes = append(s.Panes, PaneState{ID: id, Focused: id == a.coreSelection.Pane, X: int(r.X), Y: int(r.Y), Cols: cols, Rows: rows, Text: v.VT.Text()})
		if id == a.coreSelection.Pane {
			s.Grid = [2]int{cols, rows}
			s.Sized = v.Fitted()
		}
	}
	slices.SortFunc(s.Panes, func(a, b PaneState) int { return strings.Compare(a.ID, b.ID) })

	return s
}
