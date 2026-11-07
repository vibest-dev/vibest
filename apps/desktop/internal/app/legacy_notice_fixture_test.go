package app

import (
	"vibest-desktop/internal/presentation"

	"time"
)

func newlyBlocked(machine string, prev, next *presentation.Snapshot, at time.Time) []notice {
	if prev == nil {
		return nil
	}
	var out []notice
	for _, ag := range next.Agents {
		if ag.AgentStatus != "blocked" {
			continue
		}
		if was := prev.Agent(ag.PaneID); was != nil && was.AgentStatus == "blocked" {
			continue
		}
		title := ag.Display
		if title == "" {
			title = "Agent"
		}
		out = append(out, notice{Machine: machine, PaneID: ag.PaneID, Title: title + " needs you", Body: ag.Title, At: at})
	}
	return out
}
