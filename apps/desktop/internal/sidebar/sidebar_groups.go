package sidebar

import "vibest-desktop/internal/presentation"

type Entry struct {
	Index int
	Child bool
	Group string
}

func (e Entry) GroupParent() bool {
	return !e.Child && e.Group != ""
}

func groupedRepoKeys(workspaces []presentation.Workspace) map[string]bool {
	parent := map[string]bool{}
	linked := map[string]bool{}
	for i := range workspaces {
		tree := workspaces[i].Worktree
		if tree == nil || tree.Key == "" {
			continue
		}
		if tree.Linked {
			linked[tree.Key] = true
		} else {
			parent[tree.Key] = true
		}
	}
	out := map[string]bool{}
	for key := range parent {
		if linked[key] {
			out[key] = true
		}
	}
	return out
}

func Entries(workspaces []presentation.Workspace) []Entry {
	grouped := groupedRepoKeys(workspaces)
	type members struct{ parents, children []int }
	byKey := map[string]*members{}
	for i := range workspaces {
		tree := workspaces[i].Worktree
		if tree == nil || !grouped[tree.Key] {
			continue
		}
		m := byKey[tree.Key]
		if m == nil {
			m = &members{}
			byKey[tree.Key] = m
		}
		if tree.Linked {
			m.children = append(m.children, i)
		} else {
			m.parents = append(m.parents, i)
		}
	}
	var entries []Entry
	for i := range workspaces {
		tree := workspaces[i].Worktree
		if tree == nil || !grouped[tree.Key] {
			entries = append(entries, Entry{Index: i})
			continue
		}
		m := byKey[tree.Key]
		if m == nil {
			continue
		}
		delete(byKey, tree.Key)
		for _, p := range m.parents {
			entries = append(entries, Entry{Index: p, Group: tree.Key})
		}
		for _, c := range m.children {
			entries = append(entries, Entry{Index: c, Child: true, Group: tree.Key})
		}
	}
	return entries
}

func VisibleEntries(workspaces []presentation.Workspace, collapsed map[string]bool) []Entry {
	var out []Entry
	for _, e := range Entries(workspaces) {
		if e.Child && collapsed[e.Group] {
			continue
		}
		out = append(out, e)
	}
	return out
}

type Shift struct {
	OK    bool
	Index int
	End   bool
	IDs   []string
}

func ShiftWorkspace(workspaces []presentation.Workspace, id string, down bool) Shift {
	pressed := -1
	for i := range workspaces {
		if workspaces[i].ID == id {
			pressed = i
			break
		}
	}
	if pressed < 0 {
		return Shift{}
	}
	var blocks [][]Entry
	for _, e := range Entries(workspaces) {
		if n := len(blocks); n > 0 && e.Group != "" && blocks[n-1][0].Group == e.Group {
			blocks[n-1] = append(blocks[n-1], e)
			continue
		}
		blocks = append(blocks, []Entry{e})
	}
	for i, block := range blocks {
		for _, e := range block {
			if e.Index != pressed {
				continue
			}
			if e.Child {
				return shiftChild(workspaces, block, pressed, down)
			}
			return shiftBlock(workspaces, blocks, i, down)
		}
	}
	return Shift{}
}

func shiftBlock(workspaces []presentation.Workspace, blocks [][]Entry, at int, down bool) Shift {
	if at < 0 || len(blocks) < 2 {
		return Shift{}
	}
	index, end, ok := blockAnchor(blocks, at, down)
	if !ok {
		return Shift{}
	}
	return Shift{OK: true, Index: index, End: end, IDs: rowIDs(workspaces, blocks[at])}
}

func shiftChild(workspaces []presentation.Workspace, block []Entry, pressed int, down bool) Shift {
	var kids []Entry
	at := -1
	for _, e := range block {
		if !e.Child {
			continue
		}
		if e.Index == pressed {
			at = len(kids)
		}
		kids = append(kids, e)
	}
	id := workspaces[pressed].ID
	if at < 0 || len(kids) < 2 {
		return Shift{}
	}
	if !down {
		if at == 0 {
			return Shift{}
		}
		return Shift{OK: true, Index: kids[at-1].Index, IDs: []string{id}}
	}
	if at+1 >= len(kids) {
		return Shift{}
	}
	if at+2 < len(kids) {
		return Shift{OK: true, Index: kids[at+2].Index, IDs: []string{id}}
	}
	last := kids[at+1].Index
	for i := last + 1; i < len(workspaces); i++ {
		if i != pressed {
			return Shift{OK: true, Index: i, IDs: []string{id}}
		}
	}
	return Shift{OK: true, End: true, IDs: []string{id}}
}

func blockAnchor(blocks [][]Entry, at int, down bool) (index int, end, ok bool) {
	if !down {
		if at == 0 {
			return 0, false, false
		}
		return minSnapshot(blocks[at-1]), false, true
	}
	if at+1 >= len(blocks) {
		return 0, false, false
	}
	if at+2 < len(blocks) {
		return minSnapshot(blocks[at+2]), false, true
	}
	return 0, true, true
}

func minSnapshot(rows []Entry) int {
	n := rows[0].Index
	for _, e := range rows[1:] {
		if e.Index < n {
			n = e.Index
		}
	}
	return n
}

func rowIDs(workspaces []presentation.Workspace, rows []Entry) []string {
	ids := make([]string, len(rows))
	for i, e := range rows {
		ids[i] = workspaces[e.Index].ID
	}
	return ids
}
