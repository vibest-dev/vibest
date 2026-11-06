package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
)

var methods = []string{
	"hello",
	"terminal.run",
	"terminal.get",
	"terminal.kill",
	"terminal.label",
	"terminal.attach",
	"machine.exec",
	"machine.list",
	"doc.get",
	"doc.set",
	"events.subscribe",
}

const (
	schemaDir = "../../packages/effect-hc-sdk/schema"
	target    = "internal/core/hc_generated.go"
	ref       = "#/components/schemas/"
)

type schema = map[string]any

type document struct {
	Info struct {
		Version     string `json:"version"`
		Description string `json:"description"`
	} `json:"info"`
	Methods []struct {
		Name   string `json:"name"`
		Params []struct {
			Name     string `json:"name"`
			Required bool   `json:"required"`
			Schema   schema `json:"schema"`
		} `json:"params"`
		Result struct {
			Schema schema `json:"schema"`
		} `json:"result"`
	} `json:"methods"`
	Components struct {
		Schemas map[string]schema `json:"schemas"`
	} `json:"components"`
}

type pin struct {
	Version    string `json:"version"`
	Generation int    `json:"generation"`
}

var initialisms = map[string]string{"id": "ID", "cwd": "CWD", "pid": "PID", "fg": "FG", "bg": "BG", "ms": "MS"}

func goName(s string) string {
	var b strings.Builder
	for _, part := range strings.FieldsFunc(s, func(r rune) bool { return r == '_' || r == '.' }) {
		if v, ok := initialisms[part]; ok {
			b.WriteString(v)
		} else {
			b.WriteString(strings.ToUpper(part[:1]) + part[1:])
		}
	}
	return b.String()
}

type generator struct {
	components map[string]schema
	reachable  map[string]bool
}

func (g *generator) visit(s schema) {
	if r, ok := s["$ref"].(string); ok {
		name := strings.TrimPrefix(r, ref)
		if !g.reachable[name] {
			g.reachable[name] = true
			g.visit(g.components[name])
		}
		return
	}
	for _, v := range s {
		switch v := v.(type) {
		case map[string]any:
			g.visit(v)
		case []any:
			for _, item := range v {
				if m, ok := item.(map[string]any); ok {
					g.visit(m)
				}
			}
		}
	}
}

func types(s schema) ([]string, bool) {
	switch t := s["type"].(type) {
	case string:
		return []string{t}, false
	case []any:
		var out []string
		nullable := false
		for _, v := range t {
			if v == "null" {
				nullable = true
			} else {
				out = append(out, v.(string))
			}
		}
		return out, nullable
	}
	return nil, false
}

func (g *generator) goType(s schema) (string, bool) {
	if r, ok := s["$ref"].(string); ok {
		return strings.TrimPrefix(r, ref), false
	}
	if alts, ok := s["anyOf"].([]any); ok {
		var inner []schema
		nullable := false
		for _, a := range alts {
			m := a.(map[string]any)
			if m["type"] == "null" {
				nullable = true
			} else {
				inner = append(inner, m)
			}
		}
		if len(inner) == 1 {
			t, _ := g.goType(inner[0])
			return t, nullable
		}
		return "json.RawMessage", false
	}
	if _, ok := s["enum"]; ok {
		return "string", false
	}
	ts, nullable := types(s)
	if len(ts) != 1 {
		return "json.RawMessage", false
	}
	switch ts[0] {
	case "string":
		return "string", nullable
	case "boolean":
		return "bool", nullable
	case "number":
		return "float64", nullable
	case "integer":
		switch s["format"] {
		case "uint8", "uint16", "uint32", "uint64", "int32", "int64":
			return s["format"].(string), nullable
		case "uint":
			return "uint", nullable
		}
		return "int64", nullable
	case "array":
		item := "json.RawMessage"
		if it, ok := s["items"].(map[string]any); ok {
			item = g.pointer(g.goType(it))
		}
		if lo, ok := s["minItems"].(float64); ok && s["maxItems"] == lo {
			return fmt.Sprintf("[%d]%s", int(lo), item), nullable
		}
		return "[]" + item, false
	case "object":
		if ap, ok := s["additionalProperties"].(map[string]any); ok {
			return "map[string]" + g.pointer(g.goType(ap)), false
		}
		return "json.RawMessage", false
	}
	return "json.RawMessage", false
}

func (g *generator) pointer(t string, nullable bool) string {
	if nullable && t != "json.RawMessage" {
		return "*" + t
	}
	return t
}

type field struct {
	name     string
	required bool
	schema   schema
}

func (g *generator) structBody(b *bytes.Buffer, fields []field, params bool) {
	for _, f := range fields {
		tag := f.name
		if params && !f.required {
			tag += ",omitempty"
		}
		fmt.Fprintf(b, "\t%s %s `json:%q`\n", goName(f.name), g.pointer(g.goType(f.schema)), tag)
	}
}

func properties(s schema) []field {
	props, _ := s["properties"].(map[string]any)
	required := map[string]bool{}
	if r, ok := s["required"].([]any); ok {
		for _, v := range r {
			required[v.(string)] = true
		}
	}
	var out []field
	for name, v := range props {
		m, _ := v.(map[string]any)
		out = append(out, field{name, required[name], m})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func (g *generator) embedded(name string) (string, []field) {
	own := properties(g.components[name])
	best := ""
	for other := range g.reachable {
		if other == name || len(properties(g.components[other])) == 0 {
			continue
		}
		props := g.components[other]["properties"].(map[string]any)
		if len(props) >= len(own) {
			continue
		}
		mine := g.components[name]["properties"].(map[string]any)
		all := true
		for k, v := range props {
			if !reflect.DeepEqual(mine[k], v) {
				all = false
				break
			}
		}
		if all && (best == "" || len(props) > len(g.components[best]["properties"].(map[string]any))) {
			best = other
		}
	}
	if best == "" {
		return "", own
	}
	shared := g.components[best]["properties"].(map[string]any)
	var rest []field
	for _, f := range own {
		if _, ok := shared[f.name]; !ok {
			rest = append(rest, f)
		}
	}
	return best, rest
}

func generate(doc document, p pin) ([]byte, error) {
	generation := regexp.MustCompile(`Protocol generation (\d+)\.`).FindStringSubmatch(doc.Info.Description)
	if doc.Info.Version != p.Version || generation == nil || generation[1] != fmt.Sprint(p.Generation) {
		return nil, fmt.Errorf("hc-openrpc.json is hc %s %v, hc-version.json pins %s generation %d", doc.Info.Version, generation, p.Version, p.Generation)
	}
	g := &generator{components: doc.Components.Schemas, reachable: map[string]bool{}}
	var b bytes.Buffer
	fmt.Fprintf(&b, "package core\n\nimport \"encoding/json\"\n\nconst (\n\tPinnedVersion = %q\n\tPinnedGeneration = %d\n)\n\n", p.Version, p.Generation)
	found := map[string]bool{}
	for _, m := range doc.Methods {
		if !contains(methods, m.Name) {
			continue
		}
		found[m.Name] = true
		var fields []field
		for _, param := range m.Params {
			fields = append(fields, field{param.Name, param.Required, param.Schema})
			g.visit(param.Schema)
		}
		g.visit(m.Result.Schema)
		sort.Slice(fields, func(i, j int) bool { return fields[i].name < fields[j].name })
		fmt.Fprintf(&b, "type %sParams struct {\n", goName(m.Name))
		g.structBody(&b, fields, true)
		b.WriteString("}\n\n")
	}
	for _, m := range methods {
		if !found[m] {
			return nil, fmt.Errorf("hc-openrpc.json has no method %s", m)
		}
	}
	names := make([]string, 0, len(g.reachable))
	for name := range g.reachable {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		s := g.components[name]
		if _, ok := s["properties"]; !ok {
			t, _ := g.goType(s)
			fmt.Fprintf(&b, "type %s %s\n\n", name, t)
			continue
		}
		base, fields := g.embedded(name)
		fmt.Fprintf(&b, "type %s struct {\n", name)
		if base != "" {
			fmt.Fprintf(&b, "\t%s\n", base)
		}
		g.structBody(&b, fields, false)
		b.WriteString("}\n\n")
	}
	return format.Source(b.Bytes())
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func read(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func main() {
	check := flag.Bool("check", false, "fail when the generated file is stale")
	flag.Parse()
	var doc document
	var p pin
	if err := read(filepath.Join(schemaDir, "hc-openrpc.json"), &doc); err != nil {
		fail(err)
	}
	if err := read(filepath.Join(schemaDir, "hc-version.json"), &p); err != nil {
		fail(err)
	}
	out, err := generate(doc, p)
	if err != nil {
		fail(err)
	}
	if *check {
		disk, _ := os.ReadFile(target)
		if !bytes.Equal(disk, out) {
			fail(fmt.Errorf("%s is stale; run go run ./scripts/hcgen", target))
		}
		fmt.Printf("%s matches hc %s (generation %d)\n", target, p.Version, p.Generation)
		return
	}
	if err := os.WriteFile(target, out, 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("generated %s for hc %s (generation %d)\n", target, p.Version, p.Generation)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "hcgen:", err)
	os.Exit(1)
}
