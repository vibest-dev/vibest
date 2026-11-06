package herdr

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func completionControl(kind, data string) []byte {
	e := &enc{}
	e.uint(msgControl)
	e.str(kind)
	e.str(data)
	return e.b
}

func TestAgentCompletionsPairing(t *testing.T) {
	type step struct {
		kind, data string
		want       map[string]uint64
	}
	projection := func(boot string, revision uint64, tokens map[string]uint64) step {
		b, err := json.Marshal(map[string]any{"boot_id": boot, "revision": revision, "completions": tokens})
		if err != nil {
			t.Fatal(err)
		}
		return step{kind: completionsKind, data: string(b)}
	}
	snapshot := func(boot string, revision uint64, want map[string]uint64) step {
		b, err := json.Marshal(map[string]any{"boot_id": boot, "revision": revision})
		if err != nil {
			t.Fatal(err)
		}
		return step{kind: snapKind, data: string(b), want: want}
	}
	tokens := map[string]uint64{"p1": 7, "p2": ^uint64(0)}
	newTokens := map[string]uint64{"p1": 9}
	empty := map[string]uint64{}
	for _, tc := range []struct {
		name  string
		steps []step
	}{
		{"exact", []step{projection("b", 1, tokens), snapshot("b", 1, tokens)}},
		{"successive snapshots immutable", []step{projection("b", 1, tokens), snapshot("b", 1, tokens), projection("b", 2, newTokens), snapshot("b", 2, newTokens)}},
		{"missing", []step{snapshot("b", 1, nil), snapshot("b", 2, nil)}},
		{"empty", []step{projection("b", 1, empty), snapshot("b", 1, empty), snapshot("b", 2, nil)}},
		{"future revision consumed", []step{projection("b", 3, tokens), snapshot("b", 2, nil), snapshot("b", 3, nil)}},
		{"past revision consumed", []step{projection("b", 1, tokens), snapshot("b", 2, nil), snapshot("b", 1, nil)}},
		{"wrong boot consumed", []step{projection("other", 1, tokens), snapshot("b", 1, nil), snapshot("other", 1, nil)}},
		{"late", []step{snapshot("b", 1, nil), projection("b", 1, tokens), snapshot("b", 2, nil)}},
		{"late before duplicate snapshot", []step{snapshot("b", 1, nil), projection("b", 1, tokens), snapshot("b", 1, nil)}},
		{"stale", []step{snapshot("b", 2, nil), projection("b", 1, tokens), snapshot("b", 1, nil)}},
		{"late leaves pending alone", []step{snapshot("b", 1, nil), projection("b", 2, newTokens), projection("b", 1, tokens), snapshot("b", 2, newTokens)}},
		{"duplicate controls", []step{projection("b", 1, tokens), projection("b", 1, tokens), snapshot("b", 1, tokens), snapshot("b", 1, nil)}},
		{"one pending projection", []step{projection("b", 2, tokens), projection("b", 3, newTokens), snapshot("b", 2, nil), snapshot("b", 3, nil)}},
		{"latest control", []step{projection("b", 1, tokens), projection("b", 2, newTokens), snapshot("b", 2, newTokens)}},
		{"boot change", []step{projection("old", 4, tokens), snapshot("old", 4, tokens), snapshot("new", 1, nil), projection("new", 2, newTokens), snapshot("new", 2, newTokens)}},
		{"old boot after change", []step{snapshot("old", 4, nil), snapshot("new", 1, nil), projection("old", 5, tokens), snapshot("new", 2, nil), snapshot("old", 5, nil)}},
		{"unrelated control", []step{projection("b", 1, tokens), {kind: "endpoint.future.v1", data: `{}`}, snapshot("b", 1, tokens)}},
		{"zero revision", []step{projection("b", 0, tokens), snapshot("b", 0, tokens)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var snapshots []*ShellSnapshot
			var wants []map[string]uint64
			s := &Shell{ready: make(chan struct{}), OnSnapshot: func(sn *ShellSnapshot) { snapshots = append(snapshots, sn) }}
			for i, st := range tc.steps {
				before := len(snapshots)
				if err := s.handle(completionControl(st.kind, st.data)); err != nil {
					t.Fatalf("step %d: %v", i, err)
				}
				if st.kind == snapKind {
					wants = append(wants, st.want)
					if len(snapshots) != before+1 || snapshots[before] != s.snap {
						t.Fatalf("step %d: snapshot callback missing or repeated", i)
					}
				} else if len(snapshots) != before {
					t.Fatalf("step %d: control invoked snapshot callback", i)
				}
				for j, sn := range snapshots {
					if !reflect.DeepEqual(sn.AgentCompletions, wants[j]) {
						t.Fatalf("step %d, snapshot %d: completions %#v, want %#v", i, j, sn.AgentCompletions, wants[j])
					}
				}
			}
		})
	}
}

func TestAgentCompletionsRejectMalformed(t *testing.T) {
	for _, data := range []string{
		`{`, `null`, `[]`,
		`{"revision":1,"completions":{}}`,
		`{"boot_id":null,"revision":1,"completions":{}}`,
		`{"boot_id":"","revision":1,"completions":{}}`,
		`{"boot_id":"b","completions":{}}`,
		`{"boot_id":"b","revision":null,"completions":{}}`,
		`{"boot_id":"b","revision":-1,"completions":{}}`,
		`{"boot_id":"b","revision":"1","completions":{}}`,
		`{"boot_id":"b","revision":1}`,
		`{"boot_id":"b","revision":1,"completions":null}`,
		`{"boot_id":"b","revision":1,"completions":[]}`,
		`{"boot_id":"b","revision":1,"completions":{"p":null}}`,
		`{"boot_id":"b","revision":1,"completions":{"p":-1}}`,
		`{"boot_id":"b","revision":1,"completions":{"p":1.5}}`,
		`{"boot_id":"b","revision":1,"completions":{"p":"1"}}`,
		`{"boot_id":"b","revision":1,"completions":{"p":18446744073709551616}}`,
		`{"boot_id":"b","revision":1,"completions":{}} garbage`,
	} {
		t.Run(data, func(t *testing.T) {
			callbacks := 0
			s := &Shell{ready: make(chan struct{}), OnSnapshot: func(*ShellSnapshot) { callbacks++ }}
			if err := s.handle(completionControl(completionsKind, `{"boot_id":"b","revision":1,"completions":{"p":7}}`)); err != nil {
				t.Fatal(err)
			}
			if err := s.handle(completionControl(completionsKind, data)); err == nil {
				t.Fatal("malformed projection accepted")
			}
			if callbacks != 0 || s.completions != nil {
				t.Fatal("malformed projection published or retained pending tokens")
			}
			if err := s.handle(completionControl(snapKind, `{"boot_id":"b","revision":1}`)); err != nil {
				t.Fatal(err)
			}
			if s.snap.AgentCompletions != nil {
				t.Fatal("old projection survived a malformed control")
			}
		})
	}
}

func TestAgentCompletionsMalformedFrames(t *testing.T) {
	for _, kind := range []string{completionsKind, snapKind} {
		t.Run(kind, func(t *testing.T) {
			callbacks := 0
			s := &Shell{ready: make(chan struct{}), OnSnapshot: func(*ShellSnapshot) { callbacks++ }}
			if err := s.handle(completionControl(completionsKind, `{"boot_id":"b","revision":1,"completions":{"p":7}}`)); err != nil {
				t.Fatal(err)
			}
			e := &enc{}
			e.uint(msgControl)
			e.str(kind)
			e.uint(10)
			e.b = append(e.b, '{')
			if err := s.handle(e.b); err == nil {
				t.Fatal("truncated control accepted")
			}
			if callbacks != 0 || s.completions != nil {
				t.Fatal("truncated control published or retained pending tokens")
			}
		})
	}
}

func TestAgentCompletionsNotSnapshotJSON(t *testing.T) {
	s := &Shell{ready: make(chan struct{}), OnSnapshot: func(*ShellSnapshot) {}}
	if err := s.handle(completionControl(snapKind, `{"boot_id":"b","revision":1,"AgentCompletions":{"p":7},"agent_completions":{"p":7}}`)); err != nil {
		t.Fatal(err)
	}
	if s.snap.AgentCompletions != nil {
		t.Fatal("snapshot JSON supplied unpaired completion tokens")
	}
	s.snap.AgentCompletions = map[string]uint64{"p": 7}
	b, err := json.Marshal(s.snap)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "Completions") || strings.Contains(string(b), "completions") {
		t.Fatalf("local projection serialized in snapshot: %s", b)
	}
}

func TestAgentCompletionsOverAConnection(t *testing.T) {
	s, f, log, ran := connect(t)
	snapshots := make(chan *ShellSnapshot, 4)
	s.OnSnapshot = func(sn *ShellSnapshot) { snapshots <- sn }
	f.control(completionsKind, `{"boot_id":"b","revision":1,"completions":{"p":7},"future":true}`)
	f.bell()
	expectLog(t, log, "bell")
	if len(snapshots) != 0 {
		t.Fatal("completion control invoked snapshot callback")
	}
	f.snapshot("b", 1)
	next := func() *ShellSnapshot {
		t.Helper()
		select {
		case sn := <-snapshots:
			return sn
		case err := <-ran:
			t.Fatalf("Run ended: %v", err)
		case <-time.After(2 * time.Second):
			t.Fatal("no snapshot callback")
		}
		return nil
	}
	first := next()
	if first.Boot != "b" || first.Revision != 1 || !reflect.DeepEqual(first.AgentCompletions, map[string]uint64{"p": 7}) {
		t.Fatalf("snapshot: %+v", first)
	}
	f.control(completionsKind, `{"boot_id":"b","revision":1,"completions":{"p":99}}`)
	f.bell()
	expectLog(t, log, "bell")
	if len(snapshots) != 0 || first.AgentCompletions["p"] != 7 {
		t.Fatal("late control changed a published snapshot or invoked its callback")
	}
	f.snapshot("b", 2)
	if sn := next(); sn.AgentCompletions != nil {
		t.Fatalf("late tokens leaked into revision 2: %#v", sn.AgentCompletions)
	}
	f.control(completionsKind, `{"boot_id":"b","revision":3,"completions":{}}`)
	f.snapshot("b", 3)
	if sn := next(); sn.AgentCompletions == nil || len(sn.AgentCompletions) != 0 {
		t.Fatalf("authoritative empty projection lost: %#v", sn.AgentCompletions)
	}
	f.control(completionsKind, `{"boot_id":"b","revision":4,"completions":{"p":null}}`)
	select {
	case err := <-ran:
		if err == nil {
			t.Fatal("Run accepted malformed projection")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not reject malformed projection")
	}
	if len(snapshots) != 0 || first.AgentCompletions["p"] != 7 {
		t.Fatal("malformed control published or changed a snapshot")
	}
}
