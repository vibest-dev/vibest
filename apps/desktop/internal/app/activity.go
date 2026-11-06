package app

import (
	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/presentation"

	"github.com/egoist/mygo/plugins/loading"
	"github.com/egoist/mygo/ui"
)

type activityScope struct {
	workspace, tab, pane string
}

func (scope activityScope) contains(s *presentation.Snapshot, pane string) bool {
	if scope.pane != "" {
		return scope.pane == pane && s.HasPane(pane)
	}
	for _, p := range s.Panes {
		if p.ID != pane {
			continue
		}
		if scope.tab != "" {
			return p.TabID == scope.tab
		}
		for _, tab := range s.Tabs {
			if tab.ID == p.TabID {
				return tab.WorkspaceID == scope.workspace
			}
		}
	}
	return false
}

func (m *machine) activity(scope activityScope) (string, string) {
	if !m.connected {
		return "", "Offline"
	}
	description, priority := "Activity unknown", 0
	pending := false
	for pane, t := range m.coreRecords {
		if !scope.contains(m.snap, pane) || !t.Reported {
			continue
		}
		pending = pending || (t.Turn > 0 && t.Turn > m.coreSeen[m.coreRefs[pane]])
		rank, text := 0, ""
		switch t.Activity() {
		case "working":
			return "working", "Working (reported)"
		case "error":
			rank, text = 4, "Error (reported)"
		case "blocked":
			rank, text = 3, "Needs attention (reported)"
		case "done":
			rank, text = 2, "Completed (reported)"
		case "idle":
			rank, text = 1, "Idle (reported)"
		}
		if rank > priority {
			priority, description = rank, text
		}
	}
	if pending {
		return "done", "Completed, not visited (reported)"
	}
	return "", description
}

func activityDescription(status string) string {
	switch status {
	case "working":
		return "Working"
	case "done":
		return "Completed, not visited"
	default:
		return ""
	}
}

func paintActivity(c *ui.Context, th *chrome.Theme, status string) {
	switch status {
	case "working":
		loading.Ring(c.Key("activity"), loading.Options{Size: th.Slot, Color: th.Working}).PassThrough().Label("activity: working")
	case "done":
		ui.Icon(c.Key("activity"), chrome.IconCheck).Size(th.Slot, th.Slot).Shrink(0).TextColor(th.Done).PassThrough().Label("activity: done")
	default:
		ui.Box(c.Key("activity")).Size(th.Slot, th.Slot).Shrink(0).PassThrough()
	}
}
