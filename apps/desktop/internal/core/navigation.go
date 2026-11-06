package core

import (
	"errors"
	"maps"
)

type Selection struct {
	Workspace string
	Tab       string
	Pane      string
	Zoom      string
	tabs      map[string]string
	panes     map[string]string
}

func (s Selection) Clone() Selection {
	s.tabs = maps.Clone(s.tabs)
	s.panes = maps.Clone(s.panes)
	return s
}

func firstPane(n *Split) string {
	if n == nil {
		return ""
	}
	if n.Pane != nil {
		return n.Pane.ID
	}
	return firstPane(n.First)
}
func (l *Layout) Tab(id string) *Tab {
	for wi := range l.Workspaces {
		for ti := range l.Workspaces[wi].Tabs {
			t := &l.Workspaces[wi].Tabs[ti]
			if t.ID == id {
				return t
			}
		}
	}
	return nil
}
func (l *Layout) Location(pane string) (workspace, tab string) {
	for _, w := range l.Workspaces {
		for _, t := range w.Tabs {
			if t.Root.find(pane) != nil {
				return w.ID, t.ID
			}
		}
	}
	return "", ""
}

func (s *Selection) Reconcile(l *Layout) {
	if s.tabs == nil {
		s.tabs = map[string]string{}
		s.panes = map[string]string{}
	}
	var w *Workspace
	for i := range l.Workspaces {
		if l.Workspaces[i].ID == s.Workspace {
			w = &l.Workspaces[i]
			break
		}
	}
	if w == nil && len(l.Workspaces) > 0 {
		w = &l.Workspaces[0]
	}
	if w == nil {
		s.Workspace, s.Tab, s.Pane, s.Zoom = "", "", "", ""
		clear(s.tabs)
		clear(s.panes)
		return
	}
	s.Workspace = w.ID
	var tab *Tab
	for i := range w.Tabs {
		if w.Tabs[i].ID == s.tabs[w.ID] {
			tab = &w.Tabs[i]
			break
		}
	}
	if tab == nil {
		tab = &w.Tabs[0]
	}
	s.Tab = tab.ID
	s.tabs[w.ID] = tab.ID
	s.Pane = s.panes[tab.ID]
	if tab.Root.find(s.Pane) == nil {
		s.Pane = firstPane(tab.Root)
	}
	s.panes[tab.ID] = s.Pane
	if tab.Root.find(s.Zoom) == nil {
		s.Zoom = ""
	}
	for workspace := range s.tabs {
		exists := false
		for _, w := range l.Workspaces {
			exists = exists || w.ID == workspace
		}
		if !exists {
			delete(s.tabs, workspace)
		}
	}
	for tab := range s.panes {
		if l.Tab(tab) == nil {
			delete(s.panes, tab)
		}
	}
}
func (s *Selection) SelectWorkspace(l *Layout, id string) error {
	for _, w := range l.Workspaces {
		if w.ID == id {
			s.Workspace = id
			s.Zoom = ""
			s.Reconcile(l)
			return nil
		}
	}
	return errors.New("layout: workspace not found")
}
func (s *Selection) SelectTab(l *Layout, id string) error {
	for _, w := range l.Workspaces {
		for _, t := range w.Tabs {
			if t.ID == id {
				if s.tabs == nil {
					s.Reconcile(l)
				}
				s.Workspace = w.ID
				s.tabs[w.ID] = id
				s.Zoom = ""
				s.Reconcile(l)
				return nil
			}
		}
	}
	return errors.New("layout: tab not found")
}
func (s *Selection) SelectPane(l *Layout, id string) error {
	w, tab := l.Location(id)
	if w == "" {
		return errors.New("layout: pane not found")
	}
	if s.tabs == nil {
		s.Reconcile(l)
	}
	s.Workspace = w
	s.tabs[w] = tab
	s.panes[tab] = id
	if s.Zoom != "" {
		s.Zoom = id
	}
	s.Reconcile(l)
	return nil
}
func (s *Selection) ToggleZoom(l *Layout, id string) error {
	was := s.Zoom == id
	if err := s.SelectPane(l, id); err != nil {
		return err
	}
	if was {
		s.Zoom = ""
	} else {
		s.Zoom = id
	}
	return nil
}
func (l *Layout) Rename(id, label string) error {
	for wi := range l.Workspaces {
		w := &l.Workspaces[wi]
		if w.ID == id {
			w.Label = label
			return nil
		}
		for ti := range w.Tabs {
			t := &w.Tabs[ti]
			if t.ID == id {
				t.Label = label
				return nil
			}
		}
	}
	if p := l.Pane(id); p != nil {
		p.Label = label
		return nil
	}
	return errors.New("layout: item not found")
}

func (l *Layout) MovePane(pane, workspace, tab string) (string, error) {
	p := l.Pane(pane)
	if p == nil {
		return "", errors.New("layout: pane not found")
	}
	_, fromTab := l.Location(pane)
	if tab == fromTab {
		return tab, nil
	}
	var target *Workspace
	for wi := range l.Workspaces {
		if l.Workspaces[wi].ID == workspace {
			target = &l.Workspaces[wi]
			break
		}
	}
	if target == nil {
		return "", errors.New("layout: workspace not found")
	}
	if tab != "" {
		exists := false
		for _, t := range target.Tabs {
			exists = exists || t.ID == tab
		}
		if !exists {
			return "", errors.New("layout: destination tab not found")
		}
	}
	moved := *p
	moved.ID = newID("moving")
	if tab == "" {
		var err error
		tab, err = l.AddTab(workspace, "", moved)
		if err != nil {
			return "", err
		}
	} else {
		t := l.Tab(tab)
		n := &Split{Pane: &moved}
		t.Root = &Split{Axis: "x", Ratio: .5, First: t.Root, Second: n}
	}
	if err := l.RemovePane(pane); err != nil {
		return "", err
	}
	l.Pane(moved.ID).ID = pane
	return tab, nil
}
