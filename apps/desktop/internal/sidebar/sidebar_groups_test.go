package sidebar

import (
	"testing"
	"vibest-desktop/internal/presentation"
)

func TestWorkspaceEntriesGroupLinkedWorktrees(t *testing.T) {
	tree := func(linked bool) *presentation.Repository {
		return &presentation.Repository{Key: "repo", Label: "repo", Linked: linked}
	}
	ws := []presentation.Workspace{
		{ID: "parent", Label: "main", Worktree: tree(false)},
		{ID: "other", Label: "other"},
		{ID: "linked", Label: "feat", Worktree: tree(true)},
	}
	got := Entries(ws)
	want := []Entry{
		{Index: 0, Group: "repo"},
		{Index: 2, Child: true, Group: "repo"},
		{Index: 1},
	}
	if len(got) != len(want) {
		t.Fatalf("entries %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("entry %d %#v, want %#v", i, got[i], want[i])
		}
	}
	alone := []presentation.Workspace{{ID: "only", Worktree: tree(true)}}
	if e := Entries(alone); len(e) != 1 || e[0].Child || e[0].Group != "" {
		t.Fatalf("ungrouped %#v", e)
	}
	folded := VisibleEntries(ws, map[string]bool{"repo": true})
	if len(folded) != 2 || folded[0].Index != 0 || folded[1].Index != 1 {
		t.Fatalf("folded %#v", folded)
	}
}

func TestShiftWorkspaceUsesGroupedOrder(t *testing.T) {
	tree := func(linked bool) *presentation.Repository {
		return &presentation.Repository{Key: "repo", Label: "repo", Linked: linked}
	}
	ws := []presentation.Workspace{
		{ID: "parent", Worktree: tree(false)},
		{ID: "other"},
		{ID: "linked", Worktree: tree(true)},
	}
	if up := ShiftWorkspace(ws, "parent", false); up.OK {
		t.Fatalf("parent up %#v", up)
	}
	down := ShiftWorkspace(ws, "parent", true)
	if !down.OK || len(down.IDs) != 2 || down.IDs[0] != "parent" || down.IDs[1] != "linked" || !down.End {
		t.Fatalf("parent down %#v", down)
	}
	if s := ShiftWorkspace(ws, "linked", false); s.OK {
		t.Fatalf("linked up %#v", s)
	}
	if s := ShiftWorkspace(ws, "linked", true); s.OK {
		t.Fatalf("linked down %#v", s)
	}
	if s := ShiftWorkspace(ws, "other", true); s.OK {
		t.Fatalf("other down %#v", s)
	}
	up := ShiftWorkspace(ws, "other", false)
	if !up.OK || len(up.IDs) != 1 || up.IDs[0] != "other" || up.End || up.Index != 0 {
		t.Fatalf("other up %#v", up)
	}
	swapped := []presentation.Workspace{
		{ID: "linked", Worktree: tree(true)},
		{ID: "parent", Worktree: tree(false)},
	}
	if s := ShiftWorkspace(swapped, "parent", false); s.OK {
		t.Fatalf("top parent up %#v", s)
	}
	if s := ShiftWorkspace(swapped, "parent", true); s.OK {
		t.Fatalf("lone group down %#v", s)
	}
}

func TestShiftWorkspaceMovesChildAmongSiblings(t *testing.T) {
	repo := func(linked bool) *presentation.Repository {
		return &presentation.Repository{Key: "repo-a", Linked: linked}
	}
	ws := []presentation.Workspace{
		{ID: "a", Worktree: repo(false)},
		{ID: "a1", Worktree: repo(true)},
		{ID: "b"},
		{ID: "a2", Worktree: repo(true)},
		{ID: "c"},
	}
	down := ShiftWorkspace(ws, "a1", true)
	if !down.OK || len(down.IDs) != 1 || down.IDs[0] != "a1" || down.End || down.Index != 4 {
		t.Fatalf("a1 down %#v", down)
	}
	up := ShiftWorkspace(ws, "a2", false)
	if !up.OK || len(up.IDs) != 1 || up.IDs[0] != "a2" || up.End || up.Index != 1 {
		t.Fatalf("a2 up %#v", up)
	}
	if s := ShiftWorkspace(ws, "b", false); !s.OK || s.End || s.Index != 0 || s.IDs[0] != "b" {
		t.Fatalf("b up %#v", s)
	}
	if s := ShiftWorkspace(ws, "b", true); !s.OK || !s.End || s.IDs[0] != "b" {
		t.Fatalf("b down %#v", s)
	}
	group := ShiftWorkspace(ws, "a", true)
	if !group.OK || group.End || ws[group.Index].ID != "c" || len(group.IDs) != 3 || group.IDs[0] != "a" || group.IDs[1] != "a1" || group.IDs[2] != "a2" {
		t.Fatalf("group down %#v", group)
	}
	if s := ShiftWorkspace(ws, "a", false); s.OK {
		t.Fatalf("group up %#v", s)
	}
}
