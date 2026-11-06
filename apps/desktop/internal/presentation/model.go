package presentation

type Snapshot struct {
	FocusedWorkspaceID string      `json:"focused_workspace_id"`
	FocusedTabID       string      `json:"focused_tab_id"`
	FocusedPaneID      string      `json:"focused_pane_id"`
	Workspaces         []Workspace `json:"workspaces"`
	Tabs               []Tab       `json:"tabs"`
	Panes              []Pane      `json:"panes"`
	Agents             []Agent     `json:"agents"`
}

type Workspace struct {
	ID          string      `json:"workspace_id"`
	ActiveTabID string      `json:"active_tab_id"`
	Number      int         `json:"number"`
	Label       string      `json:"label"`
	Branch      string      `json:"branch"`
	AheadBehind []int       `json:"git_ahead_behind"`
	Focused     bool        `json:"focused"`
	AgentStatus string      `json:"agent_status"`
	Worktree    *Repository `json:"worktree"`
}

type Repository struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Linked bool   `json:"is_linked_worktree"`
}

type Tab struct {
	ID          string `json:"tab_id"`
	WorkspaceID string `json:"workspace_id"`
	Number      int    `json:"number"`
	Label       string `json:"label"`
	Zoomed      bool   `json:"zoomed"`
	Focused     bool   `json:"focused"`
	AgentStatus string `json:"agent_status"`
}

type Pane struct {
	ID    string `json:"pane_id"`
	TabID string `json:"tab_id"`
	Label string `json:"label"`
	Cwd   string `json:"cwd"`
}

type Agent struct {
	PaneID      string `json:"pane_id"`
	WorkspaceID string `json:"workspace_id"`
	TabID       string `json:"tab_id"`
	Name        string `json:"name"`
	Display     string `json:"display_agent"`
	Agent       string `json:"agent"`
	Title       string `json:"terminal_title_stripped"`
	AgentStatus string `json:"agent_status"`
	Focused     bool   `json:"focused"`
}

func (s *Snapshot) Agent(paneID string) *Agent {
	for i := range s.Agents {
		if s.Agents[i].PaneID == paneID {
			return &s.Agents[i]
		}
	}
	return nil
}

func (s *Snapshot) HasPane(id string) bool {
	for _, p := range s.Panes {
		if p.ID == id {
			return true
		}
	}
	return false
}

func (s *Snapshot) TabsOf(workspaceID string) []Tab {
	var tabs []Tab
	for _, t := range s.Tabs {
		if t.WorkspaceID == workspaceID {
			tabs = append(tabs, t)
		}
	}
	return tabs
}

type Machine struct{ ID, Label string }
