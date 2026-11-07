package app

import (
	"strings"
	"testing"
)

func TestSidebarOmitsAgentsRoster(t *testing.T) {
	_, local, remote, tt := machineHeaderApp(t)
	if len(local.snap.Agents) == 0 || len(remote.coreRefs) == 0 || len(remote.snap.Agents) != 0 {
		t.Fatal("fixture lacks local reports or pinned remote unknown state")
	}
	tt.Frame()
	find(t, tt, "Terminals")
	absent(t, tt, "local repo", "remote repo", "machine: Remote")
	find(t, tt, "new-workspace")
	absent(t, tt, "Agents", "local agent · local task", "remote agent · remote task")
	for _, txt := range tt.Texts() {
		if strings.Contains(txt, " agent · ") || txt == "Agents" {
			t.Fatalf("roster text rendered: %q", txt)
		}
	}
	for _, id := range []string{"agent/p1", "agent/remote/p1"} {
		if _, ok := tt.Find(id); ok {
			t.Fatalf("agent row key %q rendered", id)
		}
	}
}
