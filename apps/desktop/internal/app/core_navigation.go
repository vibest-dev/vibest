package app

import (
	"math"
	"slices"
	"vibest-desktop/internal/core"
)

func (a *App) coreFocusDirection(id, dir string) {
	from, ok := a.coreBounds[id]
	if !ok || from.W <= 0 || from.H <= 0 {
		return
	}
	cx, cy := from.X+from.W/2, from.Y+from.H/2
	next := ""
	best := float32(math.MaxFloat32)
	for pane, r := range a.coreBounds {
		if pane == id || r.W <= 0 || r.H <= 0 {
			continue
		}
		dx, dy := r.X+r.W/2-cx, r.Y+r.H/2-cy
		if dir == "left" && dx >= 0 || dir == "right" && dx <= 0 || dir == "up" && dy >= 0 || dir == "down" && dy <= 0 {
			continue
		}
		if dir != "left" && dir != "right" && dir != "up" && dir != "down" {
			return
		}
		distance := dx*dx + dy*dy
		if distance < best {
			next, best = pane, distance
		}
	}
	if next != "" {
		a.ShowPane(next)
	}
}
func (a *App) coreResizePane(id, dir string) {
	_, tab := a.coreState.Layout.Location(id)
	t := a.coreState.Layout.Tab(tab)
	if t == nil {
		return
	}
	axis := "x"
	delta := float32(.05)
	switch dir {
	case "left":
		delta = -delta
	case "right":
	case "up":
		axis = "y"
		delta = -delta
	case "down":
		axis = "y"
	default:
		return
	}
	var chosen []bool
	var ratio float32
	found := false
	var visit func(*core.Split, []bool) bool
	visit = func(n *core.Split, path []bool) bool {
		if n.Pane != nil {
			return n.Pane.ID == id
		}
		inside := visit(n.First, append(slices.Clone(path), false)) || visit(n.Second, append(slices.Clone(path), true))
		if inside && !found && n.Axis == axis {
			chosen = slices.Clone(path)
			ratio = float32(n.Ratio)
			found = true
		}
		return inside
	}
	visit(t.Root, nil)
	if found {
		a.coreSetRatio(tab, chosen, max(.05, min(.95, ratio+delta)))
	}
}

func (a *App) coreActivateMachine(m *machine) {
	workspace := ""
	for _, w := range a.coreState.Layout.Workspaces {
		if w.Machine == m.id() && (workspace == "" || w.ID == m.coreWorkspace) {
			workspace = w.ID
		}
	}
	if workspace != "" {
		a.SelectWorkspace(workspace)
		return
	}
	a.coreSelect(nil)
	a.machine = m
	a.corePending = true
	a.navigationNote = "No workspace on " + m.label() + "; create a workspace explicitly"
	a.invalidate()
}

type coreVisitToken struct {
	ref           core.TerminalRef
	turn, program uint64
}
type coreVisit struct {
	session *core.Session
	scope   activityScope
	tokens  map[string]coreVisitToken
}

func (scope activityScope) containsLayout(l *core.Layout, pane string) bool {
	w, t := l.Location(pane)
	if w == "" {
		return false
	}
	if scope.pane != "" {
		return scope.pane == pane
	}
	if scope.tab != "" {
		return scope.tab == t
	}
	return scope.workspace == w
}
func (a *App) captureCoreVisit(scope activityScope) coreVisit {
	v := coreVisit{session: a.coreSession, scope: scope, tokens: map[string]coreVisitToken{}}
	if v.session == nil || !a.coreState.Connected {
		return v
	}
	for _, m := range a.machines {
		for pane, t := range m.coreRecords {
			if scope.containsLayout(&a.coreState.Layout, pane) && t.Reported && t.Turn > 0 {
				ref := m.coreRefs[pane]
				v.tokens[pane] = coreVisitToken{ref, t.Turn, a.coreState.Programs[ref.Address]}
			}
		}
	}
	return v
}

func (a *App) acknowledgeCoreVisit(v coreVisit) {
	if v.session == nil || v.session != a.coreSession {
		return
	}
	state := v.session.State()
	if !state.Connected {
		return
	}
	for pane, token := range v.tokens {
		p := state.Layout.Pane(pane)
		record := state.Terminals[token.ref.Address]
		if p == nil || p.Terminal != token.ref || !v.scope.containsLayout(&state.Layout, pane) || !record.Reported || record.Turn != token.turn || state.Programs[token.ref.Address] != token.program {
			continue
		}
		for _, m := range a.machines {
			if m.coreRefs[pane] == token.ref {
				m.coreSeen[token.ref] = token.turn
			}
		}
	}
}
