package vibest

import (
	"encoding/json"
	"fmt"
	"testing"
)

func ptr[T any](v T) *T { return &v }

func session(id, project string, created float64, parent *string, status string) Session {
	return Session{ID: id, Name: id, ProjectID: project, CreatedAt: created, ParentID: parent, Status: status, Runtime: "hc", Address: Address{Machine: "local", ID: "t-" + id}}
}

func shape(g Group) string {
	out := g.Project.Name() + fmt.Sprintf(" waiting=%d working=%d:", g.Waiting, g.Working)
	for _, r := range g.Rows {
		out += fmt.Sprintf(" %s/%d", r.Session.ID, r.Depth)
		if r.Main {
			out += "*"
		}
	}
	return out
}

func TestGroupsPutTheMainAgentFirstWithItsSubagentsNestedUnderIt(t *testing.T) {
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
	groups := m.Groups()
	got := []string{shape(groups[0]), shape(groups[1])}
	want := []string{
		"alpha waiting=0 working=0: other/0",
		"zeta waiting=1 working=1: main/0* sub/1 subsub/2 early/0 orphan/0",
	}
	if len(groups) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("%q", got)
	}
}

func TestDeltasUpdateAndEndSessions(t *testing.T) {
	var m Model
	m.Apply(Event{Tag: "Snapshot", Projects: []Project{{ID: "p1", Directory: ptr("/code/a")}}})
	m.Apply(Event{Tag: "Session", Session: ptr(session("s", "p1", 1, nil, "working"))})
	m.Apply(Event{Tag: "Project", Project: &Project{ID: "p1", Directory: ptr("/code/a"), EntrySessionID: ptr("s")}})
	if got := shape(m.Groups()[0]); got != "a waiting=0 working=1: s/0*" {
		t.Fatal(got)
	}
	m.Apply(Event{Tag: "Session", Session: ptr(session("s", "p1", 1, nil, "idle"))})
	if got := shape(m.Groups()[0]); got != "a waiting=0 working=0: s/0*" {
		t.Fatal(got)
	}
	m.Apply(Event{Tag: "SessionEnded", ID: "s", ProjectID: "p1"})
	if got := shape(m.Groups()[0]); got != "a waiting=0 working=0:" {
		t.Fatal(got)
	}
}

func TestAParentCycleStillShowsEverySession(t *testing.T) {
	var m Model
	m.Apply(Event{Tag: "Snapshot", Projects: []Project{{ID: "p", Directory: ptr("/a")}}, Sessions: []Session{
		session("x", "p", 1, ptr("y"), "idle"),
		session("y", "p", 2, ptr("x"), "idle"),
	}})
	if got := shape(m.Groups()[0]); got != "a waiting=0 working=0: x/0 y/1" {
		t.Fatal(got)
	}
}

func TestCoreAddressOnlyForHcSessions(t *testing.T) {
	s := session("s", "p", 1, nil, "idle")
	if a, ok := s.CoreAddress(); !ok || a != "t-s" {
		t.Fatal(a, ok)
	}
	s.Address.Machine = "box"
	if a, ok := s.CoreAddress(); !ok || a != "box/t-s" {
		t.Fatal(a, ok)
	}
	s.Runtime = "herdr"
	if _, ok := s.CoreAddress(); ok {
		t.Fatal("a herdr session has no Core terminal")
	}
}

func TestWatchEventsDecodeFromThePlannedShape(t *testing.T) {
	line := `{"_tag":"Snapshot","projects":[{"id":"p","directory":"/a","entrySessionId":null}],"sessions":[{"id":"s","name":"n","agent":"a","harness":"pi","provider":null,"model":null,"status":"idle","startedAt":null,"exitedAt":null,"turnState":"none","projectId":"p","runtime":"hc","address":{"machine":"local","id":"t1"},"worktree":"/a","repositoryRoot":null,"git":null,"createdAt":1,"lastActive":1,"task":null,"latest":null,"parentId":null}]}`
	var e Event
	strictDecode(t, json.RawMessage(line), &e)
	var m Model
	m.Apply(e)
	if got := shape(m.Groups()[0]); got != "a waiting=0 working=0: s/0" {
		t.Fatal(got)
	}
}
