package project

import (
	"context"
	"encoding/json"
	"testing"

	"vibest-desktop/internal/core"
)

func str(s string) *string { return &s }
func term(addr, parent, state, kind string, labels ...string) core.Terminal {
	t := core.Terminal{Address: addr, State: "live", Labels: map[string]string{}}
	if parent != "" {
		t.Parent = str(parent)
	}
	if state != "" {
		t.Status = &core.Status{State: state}
		if kind != "" {
			t.Status.Kind = str(kind)
		}
	}
	for _, l := range labels {
		t.Labels[Label(l)] = "1"
	}
	return t
}

func TestBuildGroupsTreeOrderAndCounts(t *testing.T) {
	f := File{Projects: []Project{{ID: "b", Name: "B", Order: 1}, {ID: "a", Name: "A", Order: 0}}}
	ts := map[string]core.Terminal{}
	for _, x := range []core.Terminal{
		term("t1", "", "working", "", "a"),
		term("t2", "t1", "idle", ""),
		term("t3", "t2", "blocked", "auth"),
		term("t4", "", "blocked", "question", "a"),
		term("t5", "", "", "", "b"),
		term("t6", "", "working", ""),
		term("box/t1", "", "done", "", "b"),
		term("box/t2", "t1", "working", ""),
	} {
		ts[x.Address] = x
	}
	fin := term("t7", "", "working", "", "a")
	fin.State = "finished"
	ts["t7"] = fin
	g := Build(f, ts, []core.Machine{{Name: "box", State: "unreachable"}})
	if len(g) != 3 || g[0].Name() != "A" || g[1].Name() != "B" || g[2].Name() != "Unassigned" {
		t.Fatalf("groups: %+v", g)
	}
	var order []string
	for _, r := range g[0].Rows {
		order = append(order, r.Address)
	}
	if want := "t1 t2 t3 t4"; join(order) != want {
		t.Fatalf("A order %q want %q", join(order), want)
	}
	if g[0].Waiting != 2 || g[0].Working != 1 {
		t.Fatalf("A counts %+v", g[0])
	}
	if r := g[0].Rows[3]; r.Reason != "question" || !r.Blocked || !r.Member {
		t.Fatalf("t4 %+v", r)
	}
	if r := g[0].Rows[2]; r.Depth != 2 || r.Reason != "auth" || r.Member {
		t.Fatalf("t3 %+v", r)
	}
	if len(g[1].Rows) != 3 || g[1].Rows[2].Address != "box/t2" || g[1].Rows[2].Depth != 1 || !g[1].Rows[1].Offline || g[1].Rows[1].Machine != "box" {
		t.Fatalf("B %+v", g[1].Rows)
	}
	h := Build(File{}, map[string]core.Terminal{"t1": term("t1", "", "idle", ""), "t2": term("t2", "", "blocked", "")}, nil)
	if h[0].Rows[0].Address != "t2" {
		t.Fatalf("blocked first: %+v", h[0].Rows)
	}
	if len(g[2].Rows) != 1 || g[2].Rows[0].Address != "t6" || g[2].Rows[0].Offline {
		t.Fatalf("unassigned %+v", g[2].Rows)
	}
}

func join(s []string) string {
	o := ""
	for i, x := range s {
		if i > 0 {
			o += " "
		}
		o += x
	}
	return o
}

type fake struct {
	value     json.RawMessage
	version   uint64
	rivals    int
	sets, get int
}

func (f *fake) call(_ context.Context, method string, params, result any) error {
	switch method {
	case "doc.get":
		f.get++
		b, _ := json.Marshal(map[string]any{"value": f.value, "version": f.version})
		return json.Unmarshal(b, result)
	case "doc.set":
		f.sets++
		p := params.(map[string]any)
		if f.rivals > 0 {
			f.rivals--
			f.version++
			f.value, _ = json.Marshal(File{Schema: 1, Projects: []Project{{ID: "rival", Name: "Rival"}}})
		}
		if p["version"].(uint64) != f.version {
			e := &core.RPCError{}
			e.Data.Kind = "conflict"
			return e
		}
		f.version++
		f.value, _ = json.Marshal(p["value"])
		return nil
	}
	return nil
}

func TestUpdateRetriesOnConflictAndKeepsRivalWrite(t *testing.T) {
	f := &fake{rivals: 2}
	got, err := Create(context.Background(), f.call, Project{ID: "x", Name: " Mine ", Core: "c1", CWD: "/w"})
	if err != nil {
		t.Fatal(err)
	}
	if f.sets != 3 || f.get != 3 {
		t.Fatalf("sets=%d gets=%d", f.sets, f.get)
	}
	if len(got.Projects) != 2 || got.Projects[0].ID != "rival" || got.Projects[1].Name != "Mine" || got.Projects[1].CWD != "/w" || got.Projects[1].Core != "c1" || got.Projects[1].Order != 1 {
		t.Fatalf("%+v", got)
	}
	f = &fake{rivals: 99}
	if _, err = Create(context.Background(), f.call, Project{ID: "x", Name: "Mine"}); err == nil || f.sets != maxRetries {
		t.Fatalf("err=%v sets=%d", err, f.sets)
	}
}

func TestRunOptionsUseProjectDirectoryAndLabel(t *testing.T) {
	o := RunOptions(Project{ID: "p", Core: "c1", CWD: "/w"}, core.RunOptions{})
	if o.CWD != "/w" || o.On != "c1" || !o.Keep || o.Labels[Label("p")] != "1" {
		t.Fatalf("%+v", o)
	}
}
