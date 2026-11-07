package vibest

import (
	"encoding/json"
	"testing"
)

func ptr[T any](v T) *T { return &v }

func session(id, project string, created float64, parent *string, status string) Session {
	return Session{ID: id, Name: id, ProjectID: project, CreatedAt: created, ParentID: parent, Status: status, Runtime: "hc", Address: Address{Machine: "local", ID: "t-" + id}}
}

func shape(g Group) string {
	out := g.Project.Name() + ":"
	for _, r := range g.Rows {
		out += " " + r.Session.ID
		if r.Main {
			out += "*"
		}
	}
	return out
}

func TestGroupsKeepMainAndSubagentsAdjacentAndIncludeEveryProject(t *testing.T) {
	var m Model
	m.Apply(Event{Tag: "Snapshot",
		Projects: []Project{
			{ID: "p1", Directory: ptr("/code/zeta"), EntrySessionID: ptr("main")},
			{ID: "p2", Directory: ptr("/code/alpha")},
			{ID: "p3"},
		},
		Sessions: []Session{
			session("early", "p1", 1, nil, "idle"),
			session("main", "p1", 2, nil, "working"),
			session("sub", "p1", 3, ptr("main"), "blocked"),
			session("subsub", "p1", 4, ptr("sub"), "idle"),
			session("orphan", "p1", 5, ptr("gone"), "done"),
			session("other", "p2", 1, nil, "idle"),
		},
	})
	groups := m.Groups(nil)
	got := []string{shape(groups[0]), shape(groups[1]), shape(groups[2])}
	want := []string{
		"alpha: other",
		"p3:",
		"zeta: main* sub subsub early orphan",
	}
	if len(groups) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("%q", got)
	}
}

func TestDeltasUpdateAndEndSessions(t *testing.T) {
	var m Model
	m.Apply(Event{Tag: "Snapshot", Projects: []Project{{ID: "p1", Directory: ptr("/code/a")}}})
	m.Apply(Event{Tag: "Session", Session: ptr(session("s", "p1", 1, nil, "working"))})
	m.Apply(Event{Tag: "Project", Project: &Project{ID: "p1", Directory: ptr("/code/a"), EntrySessionID: ptr("s")}})
	if got := shape(m.Groups(nil)[0]); got != "a: s*" {
		t.Fatal(got)
	}
	m.Apply(Event{Tag: "Session", Session: ptr(session("s", "p1", 1, nil, "idle"))})
	if got := shape(m.Groups(nil)[0]); got != "a: s*" {
		t.Fatal(got)
	}
	m.Apply(Event{Tag: "SessionEnded", ID: "s", ProjectID: "p1"})
	if got := shape(m.Groups(nil)[0]); got != "a:" {
		t.Fatal(got)
	}
}

func TestAParentCycleStillShowsEverySession(t *testing.T) {
	var m Model
	m.Apply(Event{Tag: "Snapshot", Projects: []Project{{ID: "p", Directory: ptr("/a")}}, Sessions: []Session{
		session("x", "p", 1, ptr("y"), "idle"),
		session("y", "p", 2, ptr("x"), "idle"),
	}})
	if got := shape(m.Groups(nil)[0]); got != "a: x y" {
		t.Fatal(got)
	}
}

func TestCoreAddressOnlyForHcSessions(t *testing.T) {
	s := session("s", "p", 1, nil, "idle")
	if a, ok := s.CoreAddress("/run/core.sock"); !ok || a != "t-s" {
		t.Fatal(a, ok)
	}
	s.Address.ID = "t3@/run/core.sock"
	if a, ok := s.CoreAddress("/run/core.sock"); !ok || a != "t3" {
		t.Fatal(a, ok)
	}
	if _, ok := s.CoreAddress("/run/other.sock"); ok {
		t.Fatal("a terminal on another core is not in this Core")
	}
	s.Address.Machine = "box"
	if a, ok := s.CoreAddress("/run/core.sock"); !ok || a != "box/t3" {
		t.Fatal(a, ok)
	}
	s.Runtime = "herdr"
	if _, ok := s.CoreAddress("/run/core.sock"); ok {
		t.Fatal("a herdr session has no Core terminal")
	}
}

func TestWatchEventsDecodeFromThePlannedShape(t *testing.T) {
	line := `{"_tag":"Snapshot","projects":[{"id":"p","directory":"/a","entrySessionId":null}],"sessions":[{"id":"s","name":"n","agent":"a","harness":"pi","provider":null,"model":null,"status":"idle","startedAt":null,"exitedAt":null,"turnState":"none","projectId":"p","runtime":"hc","address":{"machine":"local","id":"t1"},"worktree":"/a","repositoryRoot":null,"git":null,"createdAt":1,"lastActive":1,"task":null,"latest":null,"parentId":null}]}`
	var e Event
	strictDecode(t, json.RawMessage(line), &e)
	var m Model
	m.Apply(e)
	if got := shape(m.Groups(nil)[0]); got != "a: s" {
		t.Fatal(got)
	}
	line = `{"_tag":"Snapshot","projects":[{"id":"p","directory":"/a","entrySessionId":null,"activity":"done"}],"sessions":[{"id":"s","name":"n","agent":"a","harness":"pi","provider":null,"model":null,"status":"done","startedAt":null,"exitedAt":null,"turnState":"none","projectId":"p","runtime":"hc","address":{"machine":"local","id":"t1"},"worktree":"/a","repositoryRoot":null,"git":null,"createdAt":1,"lastActive":1,"task":null,"latest":null,"parentId":null,"turn":3}]}`
	strictDecode(t, json.RawMessage(line), &e)
	m.Apply(e)
	if m.Projects["p"].Activity != "done" || m.Sessions["s"].Turn == nil || *m.Sessions["s"].Turn != 3 || m.Sessions["s"].Status != "done" {
		t.Fatalf("%+v %+v", m.Projects["p"], m.Sessions["s"])
	}
}

func TestPinnedSessionsGoFirstAmongTheirSiblings(t *testing.T) {
	var m Model
	m.Apply(Event{Tag: "Snapshot", Projects: []Project{{ID: "p", Directory: ptr("/a"), EntrySessionID: ptr("main")}}, Sessions: []Session{
		session("main", "p", 1, nil, "idle"),
		session("s1", "p", 2, ptr("main"), "idle"),
		session("s2", "p", 3, ptr("main"), "idle"),
		session("loose", "p", 4, nil, "idle"),
	}})
	pinned := func(s Session) bool { return s.ID == "s2" || s.ID == "loose" }
	if got := shape(m.Groups(pinned)[0]); got != "a: loose main* s2 s1" {
		t.Fatal(got)
	}
}
