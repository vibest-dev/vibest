package app

import (
	"context"
	"strconv"
	"time"

	"vibest-desktop/internal/core"
	"vibest-desktop/internal/vibest"
)

const (
	seenLabel   = "herdr.seen"
	pinnedLabel = "herdr.pinned"
)

type seenWindow struct {
	seenThisTurn map[string]float64
	seenPending  map[string]float64
	seenFrame    map[string]bool
}

func labelSeen(t core.Terminal) (uint64, bool) {
	v, ok := t.Labels[seenLabel]
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseUint(v, 10, 64)
	return n, err == nil
}

func turnUnseen(t core.Terminal, fallback uint64) bool {
	seen, ok := labelSeen(t)
	if !ok || fallback > seen {
		seen = fallback
	}
	return t.Turn > 0 && t.Turn > seen
}

func pinned(t core.Terminal) bool { return t.Labels[pinnedLabel] != "" }

func (a *App) lookedAt(address string) {
	if !a.windowFocused {
		return
	}
	s, ok := a.sessionForTerminal(address)
	if !ok || s.Turn == nil {
		return
	}
	turn := *s.Turn
	if a.seenFrame == nil {
		a.seenFrame = map[string]bool{}
		a.seenThisTurn = map[string]float64{}
		a.seenPending = map[string]float64{}
	}
	a.seenFrame[s.ID] = true
	if prev, looked := a.seenThisTurn[s.ID]; looked && prev == turn {
		return
	}
	if prev, waiting := a.seenPending[s.ID]; waiting && prev == turn {
		return
	}
	a.seenPending[s.ID] = turn
	a.markSeen(s, turn)
}

func (a *App) sessionForTerminal(address string) (vibest.Session, bool) {
	var found vibest.Session
	ok := false
	for _, s := range a.vibestModel.Sessions {
		got, match := a.sessionAddress(s)
		if !match || got != address {
			continue
		}
		if !ok || s.ID < found.ID {
			found, ok = s, true
		}
	}
	return found, ok
}

func (a *App) markSeen(s vibest.Session, turn float64) {
	dir := "/"
	if p, ok := a.vibestModel.Projects[s.ProjectID]; ok && directory(p) != "" {
		dir = directory(p)
	}
	id := s.ID
	socket, dial := a.vibestSocket, a.dialVibest
	if socket == "" || dial == nil {
		delete(a.seenPending, id)
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		c, err := dial(ctx, socket)
		if err == nil {
			defer c.Close()
			err = c.Seen(ctx, dir, vibest.SeenParams{ID: id, Turn: turn})
		}
		a.mu.Lock()
		if a.seenPending[id] == turn {
			delete(a.seenPending, id)
		}
		if err == nil {
			if a.seenThisTurn == nil {
				a.seenThisTurn = map[string]float64{}
			}
			if prev, ok := a.seenThisTurn[id]; !ok || turn > prev {
				a.seenThisTurn[id] = turn
			}
		}
		a.mu.Unlock()
	}()
}

func (a *App) endSeenFrame() {
	for id := range a.seenThisTurn {
		if !a.seenFrame[id] {
			delete(a.seenThisTurn, id)
		}
	}
	clear(a.seenFrame)
}

func (a *App) writeLabel(address, key, value string) {
	c := a.coreClient
	if c == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = c.Call(ctx, "terminal.label", core.TerminalLabelParams{Terminal: address, Labels: map[string]string{key: value}}, nil)
	}()
}

func (a *App) sessionAddress(s vibest.Session) (string, bool) {
	return s.CoreAddress(a.socket)
}

func (a *App) sessionTerminal(s vibest.Session) (core.Terminal, bool) {
	address, ok := a.sessionAddress(s)
	if !ok {
		return core.Terminal{}, false
	}
	t, ok := a.coreState.Terminals[address]
	return t, ok
}

func (a *App) sessionPinned(s vibest.Session) bool {
	t, ok := a.sessionTerminal(s)
	return ok && pinned(t)
}
