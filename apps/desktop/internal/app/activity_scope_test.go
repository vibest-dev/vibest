package app

import (
	"testing"
)

func TestActivityScopesUseReportedCoreTerminals(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	reportActivity(t, a, f, "a", "working", 1, true)
	coreAppAct(a, func() {
		for _, tc := range []struct {
			scope activityScope
			want  string
			count int
		}{
			{activityScope{workspace: "w1"}, "working", 3}, {activityScope{tab: "t1"}, "working", 2}, {activityScope{tab: "t2"}, "done", 1}, {activityScope{pane: "b"}, "done", 1}, {activityScope{workspace: "missing"}, "", 0},
		} {
			count := 0
			for pane := range a.machine.coreRecords {
				if tc.scope.containsLayout(&a.coreState.Layout, pane) {
					count++
				}
			}
			status, _ := a.machine.activity(tc.scope)
			if status != tc.want || count != tc.count {
				t.Fatalf("%+v: %q/%d want %q/%d", tc.scope, status, count, tc.want, tc.count)
			}
		}
	})
}
