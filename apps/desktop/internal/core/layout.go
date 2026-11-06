package core

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"slices"
)

const LayoutDocument = "reherdr-layout"
const LayoutSchema = 1

type Layout struct {
	Schema     int         `json:"schema"`
	CoreID     string      `json:"core_id"`
	Workspaces []Workspace `json:"workspaces"`
}
type Workspace struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	CWD         string `json:"cwd"`
	Machine     string `json:"machine,omitempty"`
	Project     string `json:"project,omitempty"`
	Tabs        []Tab  `json:"tabs"`
	Repository  string `json:"repository,omitempty"`
	Linked      bool   `json:"linked,omitempty"`
	Branch      string `json:"branch,omitempty"`
	AheadBehind []int  `json:"ahead_behind,omitempty"`
}
type Tab struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Root  *Split `json:"root"`
}

type Split struct {
	Pane   *Pane   `json:"pane,omitempty"`
	Axis   string  `json:"axis,omitempty"`
	Ratio  float64 `json:"ratio,omitempty"`
	First  *Split  `json:"first,omitempty"`
	Second *Split  `json:"second,omitempty"`
}
type Pane struct {
	ID       string      `json:"id"`
	Label    string      `json:"label"`
	Tint     string      `json:"tint,omitempty"`
	Terminal TerminalRef `json:"terminal"`
}

type TerminalRef struct {
	CoreID  string `json:"core_id"`
	Address string `json:"address"`
}

func newID(prefix string) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return prefix + "-" + hex.EncodeToString(b[:])
}
func NewPane(ref TerminalRef) Pane { return Pane{ID: newID("pane"), Terminal: ref} }
func (l *Layout) AddWorkspace(label, cwd, machine string, pane Pane) string {
	w := Workspace{ID: newID("workspace"), Label: label, CWD: cwd, Machine: machine, Tabs: []Tab{{ID: newID("tab"), Root: &Split{Pane: &pane}}}}
	l.Workspaces = append(l.Workspaces, w)
	return w.ID
}
func (l *Layout) AddTab(workspace, label string, pane Pane) (string, error) {
	for i := range l.Workspaces {
		w := &l.Workspaces[i]
		if w.ID == workspace {
			tab := Tab{ID: newID("tab"), Label: label, Root: &Split{Pane: &pane}}
			w.Tabs = append(w.Tabs, tab)
			return tab.ID, nil
		}
	}
	return "", errors.New("layout: workspace not found")
}
func (s *Split) find(id string) *Split {
	if s == nil {
		return nil
	}
	if s.Pane != nil && s.Pane.ID == id {
		return s
	}
	if n := s.First.find(id); n != nil {
		return n
	}
	return s.Second.find(id)
}
func (l *Layout) paneNode(id string) *Split {
	for wi := range l.Workspaces {
		for ti := range l.Workspaces[wi].Tabs {
			if n := l.Workspaces[wi].Tabs[ti].Root.find(id); n != nil {
				return n
			}
		}
	}
	return nil
}
func (l *Layout) Pane(id string) *Pane {
	if n := l.paneNode(id); n != nil {
		return n.Pane
	}
	return nil
}
func (l *Layout) SplitPane(id, direction string, pane Pane) error {
	n := l.paneNode(id)
	if n == nil {
		return errors.New("layout: pane not found")
	}
	axis := "x"
	switch direction {
	case "left", "right":
	case "up", "down":
		axis = "y"
	default:
		return errors.New("layout: invalid split direction")
	}
	a, b := &Split{Pane: n.Pane}, &Split{Pane: &pane}
	if direction == "left" || direction == "up" {
		a, b = b, a
	}
	*n = Split{Axis: axis, Ratio: .5, First: a, Second: b}
	return nil
}
func (s *Split) remove(id string) *Split {
	if s == nil {
		return nil
	}
	if s.Pane != nil {
		if s.Pane.ID == id {
			return nil
		}
		return s
	}
	s.First = s.First.remove(id)
	s.Second = s.Second.remove(id)
	if s.First == nil {
		return s.Second
	}
	if s.Second == nil {
		return s.First
	}
	return s
}

func (l *Layout) RemovePane(id string) error {
	if l.Pane(id) == nil {
		return errors.New("layout: pane not found")
	}
	for wi := range l.Workspaces {
		w := &l.Workspaces[wi]
		for ti := range w.Tabs {
			w.Tabs[ti].Root = w.Tabs[ti].Root.remove(id)
		}
		w.Tabs = slices.DeleteFunc(w.Tabs, func(t Tab) bool { return t.Root == nil })
	}
	l.Workspaces = slices.DeleteFunc(l.Workspaces, func(w Workspace) bool { return len(w.Tabs) == 0 })
	return nil
}
func (l *Layout) SwapPanes(a, b string) error {
	na, nb := l.paneNode(a), l.paneNode(b)
	if na == nil || nb == nil {
		return errors.New("layout: pane not found")
	}
	na.Pane, nb.Pane = nb.Pane, na.Pane
	return nil
}
func (l *Layout) SetRatio(tab string, path []bool, ratio float64) error {
	if math.IsNaN(ratio) || math.IsInf(ratio, 0) || ratio < .05 || ratio > .95 {
		return errors.New("layout: invalid split ratio")
	}
	for wi := range l.Workspaces {
		for ti := range l.Workspaces[wi].Tabs {
			t := &l.Workspaces[wi].Tabs[ti]
			if t.ID != tab {
				continue
			}
			n := t.Root
			for _, second := range path {
				if n == nil || n.Pane != nil {
					return errors.New("layout: split not found")
				}
				if second {
					n = n.Second
				} else {
					n = n.First
				}
			}
			if n == nil || n.Pane != nil {
				return errors.New("layout: split not found")
			}
			n.Ratio = ratio
			return nil
		}
	}
	return errors.New("layout: tab not found")
}
func move[T any](xs []T, from, to int) []T {
	v := xs[from]
	xs = slices.Delete(xs, from, from+1)
	to = max(0, min(to, len(xs)))
	return slices.Insert(xs, to, v)
}
func (l *Layout) MoveWorkspace(id string, index int) error {
	for i, w := range l.Workspaces {
		if w.ID == id {
			l.Workspaces = move(l.Workspaces, i, index)
			return nil
		}
	}
	return errors.New("layout: workspace not found")
}

func (l *Layout) MoveWorkspaceBlock(ids []string, before string) error {
	selected := map[string]bool{}
	for _, id := range ids {
		if selected[id] {
			return errors.New("layout: duplicate workspace")
		}
		selected[id] = true
	}
	var block, rest []Workspace
	for _, w := range l.Workspaces {
		if selected[w.ID] {
			block = append(block, w)
		} else {
			rest = append(rest, w)
		}
	}
	if len(block) != len(ids) {
		return errors.New("layout: workspace not found")
	}
	at := len(rest)
	if before != "" {
		at = slices.IndexFunc(rest, func(w Workspace) bool { return w.ID == before })
		if at < 0 {
			return errors.New("layout: workspace anchor not found")
		}
	}
	l.Workspaces = slices.Concat(rest[:at], block, rest[at:])
	return nil
}
func (l *Layout) MoveTab(id string, index int) error {
	for wi := range l.Workspaces {
		w := &l.Workspaces[wi]
		for i, t := range w.Tabs {
			if t.ID == id {
				w.Tabs = move(w.Tabs, i, index)
				return nil
			}
		}
	}
	return errors.New("layout: tab not found")
}

func (l Layout) Validate(coreID string) error {
	if l.Schema != LayoutSchema || l.CoreID != coreID {
		return errors.New("layout: unsupported schema or different owning Core")
	}
	seen := map[string]bool{}
	terminals := map[TerminalRef]bool{}
	checkID := func(id string) error {
		if id == "" || seen[id] || len(id) > 128 {
			return fmt.Errorf("layout: invalid/duplicate id %q", id)
		}
		seen[id] = true
		if len(seen) > 4096 {
			return errors.New("layout: too many items")
		}
		return nil
	}
	var walk func(*Split, int) error
	walk = func(s *Split, depth int) error {
		if s == nil || depth > 32 {
			return errors.New("layout: missing or excessively deep split")
		}
		if s.Pane != nil {
			p := s.Pane
			if err := checkID(p.ID); err != nil {
				return err
			}
			if s.First != nil || s.Second != nil || s.Axis != "" || s.Ratio != 0 || p.Terminal.CoreID == "" || p.Terminal.Address == "" || terminals[p.Terminal] {
				return errors.New("layout: invalid pane or duplicate terminal")
			}
			terminals[p.Terminal] = true
			return nil
		}
		if (s.Axis != "x" && s.Axis != "y") || math.IsNaN(s.Ratio) || math.IsInf(s.Ratio, 0) || s.Ratio < .05 || s.Ratio > .95 {
			return errors.New("layout: invalid split")
		}
		if err := walk(s.First, depth+1); err != nil {
			return err
		}
		return walk(s.Second, depth+1)
	}
	for _, w := range l.Workspaces {
		if err := checkID(w.ID); err != nil {
			return err
		}
		if len(w.Tabs) == 0 {
			return errors.New("layout: empty workspace")
		}
		if len(w.AheadBehind) != 0 && (len(w.AheadBehind) != 2 || w.AheadBehind[0] < 0 || w.AheadBehind[1] < 0) {
			return errors.New("layout: invalid ahead/behind metadata")
		}
		if w.Linked && w.Repository == "" {
			return errors.New("layout: linked workspace needs repository identity")
		}
		for _, t := range w.Tabs {
			if err := checkID(t.ID); err != nil {
				return err
			}
			if err := walk(t.Root, 0); err != nil {
				return err
			}
		}
	}
	return nil
}
