package vibest

import (
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
)

const LocalMachine = "local"

type Address struct {
	Machine string `json:"machine"`
	ID      string `json:"id"`
}

type Latest struct {
	Status  string   `json:"status"`
	Summary string   `json:"summary"`
	EndedAt *float64 `json:"endedAt"`
}

type Session struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Agent          string          `json:"agent"`
	Harness        string          `json:"harness"`
	Provider       *string         `json:"provider"`
	Model          *string         `json:"model"`
	Status         string          `json:"status"`
	StartedAt      *float64        `json:"startedAt"`
	ExitedAt       *float64        `json:"exitedAt"`
	TurnState      string          `json:"turnState"`
	ProjectID      string          `json:"projectId"`
	Runtime        string          `json:"runtime"`
	Address        Address         `json:"address"`
	Worktree       string          `json:"worktree"`
	RepositoryRoot *string         `json:"repositoryRoot"`
	Git            json.RawMessage `json:"git"`
	Routing        json.RawMessage `json:"routing,omitempty"`
	CreatedAt      float64         `json:"createdAt"`
	LastActive     float64         `json:"lastActive"`
	Task           *string         `json:"task"`
	Latest         *Latest         `json:"latest"`
	ParentID       *string         `json:"parentId"`
}

func (s Session) CoreAddress(socket string) (string, bool) {
	if s.Runtime != "hc" || s.Address.ID == "" {
		return "", false
	}
	address, owner, named := strings.Cut(s.Address.ID, "@")
	if address == "" || named && !sameSocket(owner, socket) {
		return "", false
	}
	if s.Address.Machine == "" || s.Address.Machine == LocalMachine {
		return address, true
	}
	return s.Address.Machine + "/" + address, true
}

func sameSocket(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && ra == rb
}

type Project struct {
	ID             string  `json:"id"`
	Directory      *string `json:"directory"`
	EntrySessionID *string `json:"entrySessionId"`
}

func (p Project) Name() string {
	if p.Directory == nil || *p.Directory == "" {
		return p.ID
	}
	return filepath.Base(*p.Directory)
}

type Event struct {
	Tag       string    `json:"_tag"`
	Projects  []Project `json:"projects,omitempty"`
	Sessions  []Session `json:"sessions,omitempty"`
	Project   *Project  `json:"project,omitempty"`
	Session   *Session  `json:"session,omitempty"`
	ID        string    `json:"id,omitempty"`
	ProjectID string    `json:"projectId,omitempty"`
}

type Model struct {
	Projects map[string]Project
	Sessions map[string]Session
}

func (m *Model) Apply(e Event) {
	switch e.Tag {
	case "Snapshot":
		m.Projects = make(map[string]Project, len(e.Projects))
		m.Sessions = make(map[string]Session, len(e.Sessions))
		for _, p := range e.Projects {
			m.Projects[p.ID] = p
		}
		for _, s := range e.Sessions {
			m.Sessions[s.ID] = s
		}
	case "Project":
		if e.Project != nil {
			m.ensure()
			m.Projects[e.Project.ID] = *e.Project
		}
	case "Session":
		if e.Session != nil {
			m.ensure()
			m.Sessions[e.Session.ID] = *e.Session
		}
	case "SessionEnded":
		delete(m.Sessions, e.ID)
	}
}

func (m *Model) ensure() {
	if m.Projects == nil {
		m.Projects = map[string]Project{}
	}
	if m.Sessions == nil {
		m.Sessions = map[string]Session{}
	}
}

type Row struct {
	Session Session
	Depth   int
	Main    bool
}

type Group struct {
	Project Project
	Rows    []Row
	Waiting int
	Working int
}

func (m Model) Groups(pinned func(Session) bool) []Group {
	if pinned == nil {
		pinned = func(Session) bool { return false }
	}
	byProject := map[string][]Session{}
	for _, s := range m.Sessions {
		byProject[s.ProjectID] = append(byProject[s.ProjectID], s)
	}
	var groups []Group
	for _, p := range m.Projects {
		if p.Directory == nil {
			continue
		}
		groups = append(groups, group(p, byProject[p.ID], pinned))
	}
	sort.Slice(groups, func(i, j int) bool {
		a, b := groups[i].Project, groups[j].Project
		if a.Name() != b.Name() {
			return a.Name() < b.Name()
		}
		return a.ID < b.ID
	})
	return groups
}

func group(p Project, sessions []Session, pinned func(Session) bool) Group {
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].CreatedAt != sessions[j].CreatedAt {
			return sessions[i].CreatedAt < sessions[j].CreatedAt
		}
		return sessions[i].ID < sessions[j].ID
	})
	present := map[string]bool{}
	for _, s := range sessions {
		present[s.ID] = true
	}
	children := map[string][]Session{}
	var roots []Session
	for _, s := range sessions {
		if s.ParentID != nil && present[*s.ParentID] && *s.ParentID != s.ID {
			children[*s.ParentID] = append(children[*s.ParentID], s)
		} else {
			roots = append(roots, s)
		}
	}
	main := ""
	if p.EntrySessionID != nil {
		main = *p.EntrySessionID
	}
	pinFirst := func(list []Session) {
		sort.SliceStable(list, func(i, j int) bool { return pinned(list[i]) && !pinned(list[j]) })
	}
	sort.SliceStable(roots, func(i, j int) bool { return roots[i].ID == main && roots[j].ID != main })
	pinFirst(roots)
	for _, list := range children {
		pinFirst(list)
	}
	g := Group{Project: p}
	seen := map[string]bool{}
	var walk func(s Session, depth int)
	walk = func(s Session, depth int) {
		if seen[s.ID] {
			return
		}
		seen[s.ID] = true
		g.Rows = append(g.Rows, Row{Session: s, Depth: depth, Main: s.ID == main})
		switch s.Status {
		case "blocked":
			g.Waiting++
		case "working":
			g.Working++
		}
		for _, c := range children[s.ID] {
			walk(c, depth+1)
		}
	}
	for _, s := range roots {
		walk(s, 0)
	}
	for _, s := range sessions {
		walk(s, 0)
	}
	return g
}
