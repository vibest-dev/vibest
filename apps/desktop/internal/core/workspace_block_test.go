package core

import (
	"reflect"
	"testing"
)

func TestWorkspaceBlockMoveKeepsOrderAndRejectsStaleMembership(t *testing.T) {
	seed := func() Layout { return Layout{Workspaces: []Workspace{{ID: "a"}, {ID: "b"}, {ID: "c"}, {ID: "d"}}} }
	l := seed()
	if e := l.MoveWorkspaceBlock([]string{"b", "c"}, "a"); e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual([]string{l.Workspaces[0].ID, l.Workspaces[1].ID, l.Workspaces[2].ID, l.Workspaces[3].ID}, []string{"b", "c", "a", "d"}) {
		t.Fatal(l)
	}
	for _, tc := range []struct {
		ids    []string
		before string
	}{{[]string{"missing"}, "a"}, {[]string{"b", "b"}, ""}, {[]string{"b"}, "missing"}, {[]string{"b"}, "b"}} {
		l = seed()
		if e := l.MoveWorkspaceBlock(tc.ids, tc.before); e == nil || !reflect.DeepEqual(l, seed()) {
			t.Fatal("stale move changed winner", l, e)
		}
	}
}
