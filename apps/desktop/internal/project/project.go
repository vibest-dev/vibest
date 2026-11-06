package project

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"slices"
	"sort"
	"strings"

	"vibest-desktop/internal/core"
)

const (
	Document    = "reherdr-projects"
	LabelPrefix = "reherdr.project."
	maxRetries  = 5
)

type Project struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Order int    `json:"order"`
	Core  string `json:"core,omitempty"`
	CWD   string `json:"cwd,omitempty"`
}
type File struct {
	Schema   int       `json:"schema"`
	Projects []Project `json:"projects"`
}

type Call func(ctx context.Context, method string, params, result any) error

func Label(id string) string { return LabelPrefix + id }

type doc struct {
	Value   *File  `json:"value"`
	Version uint64 `json:"version"`
}

func Load(ctx context.Context, call Call) (File, error) {
	f, _, err := load(ctx, call)
	return f, err
}
func load(ctx context.Context, call Call) (File, uint64, error) {
	var d doc
	if err := call(ctx, "doc.get", map[string]string{"name": Document}, &d); err != nil {
		return File{}, 0, err
	}
	if d.Value == nil {
		return File{Schema: 1}, d.Version, nil
	}
	return *d.Value, d.Version, nil
}

func Update(ctx context.Context, call Call, change func(*File) error) (File, error) {
	for range maxRetries {
		f, version, err := load(ctx, call)
		if err != nil {
			return File{}, err
		}
		if err = change(&f); err != nil {
			return File{}, err
		}
		f.Schema = 1
		err = call(ctx, "doc.set", map[string]any{"name": Document, "value": f, "version": version}, nil)
		var rpc *core.RPCError
		if errors.As(err, &rpc) && rpc.Data.Kind == "conflict" {
			continue
		}
		return f, err
	}
	return File{}, errors.New("project: document kept changing; try again")
}

func Create(ctx context.Context, call Call, p Project) (File, error) {
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return File{}, errors.New("project: empty name")
	}
	return Update(ctx, call, func(f *File) error {
		if !slices.ContainsFunc(f.Projects, func(q Project) bool { return q.ID == p.ID }) {
			p.Order = len(f.Projects)
			f.Projects = append(f.Projects, p)
		}
		return nil
	})
}
func Rename(ctx context.Context, call Call, id, name string) (File, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return File{}, errors.New("project: empty name")
	}
	return Update(ctx, call, func(f *File) error {
		for i := range f.Projects {
			if f.Projects[i].ID == id {
				f.Projects[i].Name = name
				return nil
			}
		}
		return errors.New("project: not found")
	})
}

func Delete(ctx context.Context, call Call, id string) (File, error) {
	return Update(ctx, call, func(f *File) error {
		f.Projects = slices.DeleteFunc(f.Projects, func(p Project) bool { return p.ID == id })
		return nil
	})
}

func SetMember(ctx context.Context, call Call, address, id string, member bool) error {
	v := ""
	if member {
		v = "1"
	}
	return call(ctx, "terminal.label", map[string]any{"terminal": address, "labels": map[string]string{Label(id): v}}, nil)
}

func RunOptions(p Project, o core.RunOptions) core.RunOptions {
	o.CWD, o.On = p.CWD, p.Core
	id := p.ID
	o.Keep = true
	o.Labels = map[string]string{Label(id): "1"}
	return o
}

type Row struct {
	Address  string
	Depth    int
	Machine  string
	Offline  bool
	Activity string
	Blocked  bool
	Reason   string
	Member   bool
	Terminal core.Terminal
}

type Group struct {
	Project *Project
	Rows    []Row
	Waiting int
	Working int
}

func Build(f File, terminals map[string]core.Terminal, machines []core.Machine) []Group {
	live := make(map[string]core.Terminal, len(terminals))
	for a, t := range terminals {
		if t.State != "finished" {
			live[a] = t
		}
	}
	terminals = live
	projects := slices.Clone(f.Projects)
	sort.SliceStable(projects, func(i, j int) bool { return projects[i].Order < projects[j].Order })
	known := map[string]bool{}
	for _, p := range projects {
		known[p.ID] = true
	}
	own := func(t core.Terminal) string {
		for _, p := range projects {
			if t.Labels[Label(p.ID)] != "" {
				return p.ID
			}
		}
		return ""
	}
	parentOf := func(t core.Terminal) (core.Terminal, bool) {
		if t.Parent == nil || *t.Parent == "" {
			return core.Terminal{}, false
		}
		addr := *t.Parent
		if prefix, _, remote := strings.Cut(t.Address, "/"); remote && !strings.Contains(addr, "/") {
			addr = prefix + "/" + addr
		}
		p, ok := terminals[addr]
		return p, ok && addr != t.Address
	}
	owner := map[string]string{}
	for addr, t := range terminals {
		id, cur, seen := own(t), t, map[string]bool{addr: true}
		for id == "" {
			p, ok := parentOf(cur)
			if !ok || seen[p.Address] {
				break
			}
			seen[p.Address] = true
			id, cur = own(p), p
		}
		owner[addr] = id
	}
	online := map[string]bool{}
	for _, m := range machines {
		online[m.Name] = m.State == "connected"
	}
	offline := func(addr string) bool {
		name, _, remote := strings.Cut(addr, "/")
		return remote && !online[name]
	}
	groups := map[string]*Group{}
	var out []*Group
	for i := range projects {
		g := &Group{Project: &projects[i]}
		groups[projects[i].ID] = g
		out = append(out, g)
	}
	un := &Group{}
	groups[""] = un
	out = append(out, un)

	kids := map[string][]string{}
	var roots = map[string][]string{}
	for addr, t := range terminals {
		g := owner[addr]
		if p, ok := parentOf(t); ok && owner[p.Address] == g {
			kids[p.Address] = append(kids[p.Address], addr)
		} else {
			roots[g] = append(roots[g], addr)
		}
	}
	var hot func(string) bool
	hot = func(a string) bool {
		if terminals[a].Activity() == "blocked" {
			return true
		}
		return slices.ContainsFunc(kids[a], hot)
	}
	less := func(list []string) {
		sort.Slice(list, func(i, j int) bool {
			bi, bj := hot(list[i]), hot(list[j])
			if bi != bj {
				return bi
			}
			return addressLess(list[i], list[j])
		})
	}
	var walk func(g *Group, id, addr string, depth int)
	walk = func(g *Group, id, addr string, depth int) {
		t := terminals[addr]
		r := Row{Address: addr, Depth: depth, Offline: offline(addr), Activity: t.Activity(), Terminal: t}
		r.Machine, _, _ = strings.Cut(addr, "/")
		if !strings.Contains(addr, "/") {
			r.Machine = ""
		}
		r.Member = id != "" && t.Labels[Label(id)] != ""
		if r.Activity == "blocked" {
			r.Blocked = true
			g.Waiting++
			if t.Status.Kind != nil {
				r.Reason = *t.Status.Kind
			}
		} else if r.Activity == "working" {
			g.Working++
		}
		g.Rows = append(g.Rows, r)
		less(kids[addr])
		for _, k := range kids[addr] {
			walk(g, id, k, depth+1)
		}
	}
	for id, g := range groups {
		less(roots[id])
		for _, a := range roots[id] {
			walk(g, id, a, 0)
		}
	}
	res := make([]Group, len(out))
	for i, g := range out {
		res[i] = *g
	}
	return res
}

func addressLess(a, b string) bool {
	ma, ta, ra := strings.Cut(a, "/")
	mb, tb, rb := strings.Cut(b, "/")
	if !ra {
		ma, ta = "", a
	}
	if !rb {
		mb, tb = "", b
	}
	if ma != mb {
		return ma < mb
	}
	if len(ta) != len(tb) {
		return len(ta) < len(tb)
	}
	return ta < tb
}

func (r Row) Title() string {
	if r.Terminal.Name != nil && *r.Terminal.Name != "" {
		return *r.Terminal.Name
	}
	if r.Terminal.Title != "" {
		return r.Terminal.Title
	}
	if r.Terminal.Foreground != nil && r.Terminal.Foreground.Name != "" {
		return r.Terminal.Foreground.Name
	}
	return r.Address
}

func (g Group) Name() string {
	if g.Project == nil {
		return "Unassigned"
	}
	return g.Project.Name
}

func NewID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
