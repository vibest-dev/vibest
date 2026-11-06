package app

import (
	"context"
	"strconv"
	"strings"
	"time"

	"vibest-desktop/internal/core"
	"vibest-desktop/internal/vibest"
)

const (
	seenLabel   = "herdr.seen"
	pinnedLabel = "herdr.pinned"
)

type seenWindow struct {
	seenThisTurn map[string]uint64
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
	if !ok {
		seen = fallback
	}
	return t.Turn > 0 && t.Turn > seen
}

func pinned(t core.Terminal) bool { return t.Labels[pinnedLabel] != "" }

func (a *App) lookedAt(address string) {
	if !a.windowFocused || a.coreClient == nil {
		return
	}
	t, ok := a.coreState.Terminals[address]
	if !ok {
		return
	}
	if a.seenFrame == nil {
		a.seenFrame, a.seenThisTurn = map[string]bool{}, map[string]uint64{}
	}
	a.seenFrame[address] = true
	if turn, looked := a.seenThisTurn[address]; looked && turn == t.Turn {
		return
	}
	a.seenThisTurn[address] = t.Turn
	if seen, ok := labelSeen(t); ok && seen >= t.Turn {
		return
	}
	a.writeLabel(address, seenLabel, strconv.FormatUint(t.Turn, 10))
}

func (a *App) endSeenFrame() {
	for address := range a.seenThisTurn {
		if !a.seenFrame[address] {
			delete(a.seenThisTurn, address)
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

func withSeenZero(labels map[string]string) map[string]string {
	out := map[string]string{seenLabel: "0"}
	for k, v := range labels {
		out[k] = v
	}
	return out
}

func (a *App) sessionAddress(s vibest.Session) (string, bool) {
	address, ok := s.CoreAddress()
	if !ok {
		return "", false
	}
	if _, known := a.coreState.Terminals[address]; known {
		return address, true
	}
	machine, name, remote := strings.Cut(address, "/")
	if !remote {
		machine, name = "", address
	}
	for key, t := range a.coreState.Terminals {
		owner, _, keyRemote := strings.Cut(key, "/")
		if t.Name != nil && *t.Name == name && keyRemote == remote && (!remote || owner == machine) {
			return key, true
		}
	}
	return address, true
}

func (a *App) sessionTerminal(s vibest.Session) (core.Terminal, bool) {
	address, ok := a.sessionAddress(s)
	if !ok {
		return core.Terminal{}, false
	}
	t, ok := a.coreState.Terminals[address]
	return t, ok
}

func (a *App) sessionStatus(s vibest.Session) string {
	if s.Status == "working" || s.Status == "blocked" {
		return s.Status
	}
	t, ok := a.sessionTerminal(s)
	if !ok {
		return s.Status
	}
	if activity := t.Activity(); t.Reported && (activity == "working" || activity == "blocked") {
		return activity
	}
	if _, labelled := labelSeen(t); !labelled {
		return s.Status
	}
	if turnUnseen(t, 0) {
		return "done"
	}
	return "idle"
}

func (a *App) sessionPinned(s vibest.Session) bool {
	t, ok := a.sessionTerminal(s)
	return ok && pinned(t)
}
