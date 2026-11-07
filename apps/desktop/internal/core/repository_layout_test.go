package core

import (
	"encoding/json"
	"testing"
)

func TestRepositoryGroupingIsExplicitLayoutMetadata(t *testing.T) {
	l := Layout{Schema: 1, CoreID: "core"}
	l.AddWorkspace("Parent", "/inert", "", NewPane(TerminalRef{CoreID: "core", Address: "a"}))
	l.AddWorkspace("Child", "/inert/child", "", NewPane(TerminalRef{CoreID: "core", Address: "b"}))
	l.Workspaces[1].Linked = true
	if l.Validate("core") == nil {
		t.Fatal("linked metadata without group accepted")
	}
	l.Workspaces[0].Repository = "repo"
	l.Workspaces[1].Repository = "repo"
	if err := l.Validate("core"); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	var copy Layout
	if err := json.Unmarshal(raw, &copy); err != nil {
		t.Fatal(err)
	}
	if !copy.Workspaces[1].Linked || copy.Workspaces[0].Repository != "repo" {
		t.Fatal("layout round-trip lost grouping")
	}
}

func TestGitAheadBehindMetadataRoundTripAndUnknown(t *testing.T) {
	l := Layout{Schema: 1, CoreID: "core"}
	l.AddWorkspace("repo", "/inert", "", NewPane(TerminalRef{CoreID: "core", Address: "a"}))
	for _, ab := range [][]int{{1}, {1, 2, 3}, {-1, 0}, {0, -1}} {
		l.Workspaces[0].AheadBehind = ab
		if l.Validate("core") == nil {
			t.Fatal("invalid git counts accepted", ab)
		}
	}
	l.Workspaces[0].AheadBehind = nil
	if e := l.Validate("core"); e != nil {
		t.Fatal(e)
	}
	b, e := json.Marshal(l)
	if e != nil {
		t.Fatal(e)
	}
	var copy Layout
	if e = json.Unmarshal(b, &copy); e != nil || copy.Workspaces[0].AheadBehind != nil {
		t.Fatal("unknown Git counts became invented zero", copy, e)
	}
}
