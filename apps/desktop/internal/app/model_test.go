package app

import (
	"reflect"
	"testing"
	"time"
	"vibest-desktop/internal/presentation"
)

func TestNewlyBlocked(t *testing.T) {
	snap := func(statuses ...string) *presentation.Snapshot {
		s := &presentation.Snapshot{}
		for i, st := range statuses {
			s.Agents = append(s.Agents, presentation.Agent{PaneID: string(rune('a' + i)), Display: "Claude", Title: "t", AgentStatus: st})
		}
		return s
	}
	at := time.Unix(1, 0)
	if got := newlyBlocked("", nil, snap("blocked"), at); got != nil {
		t.Errorf("first snapshot: %v", got)
	}
	got := newlyBlocked("", snap("working", "blocked"), snap("blocked", "blocked", "blocked"), at)
	want := []notice{{PaneID: "a", Title: "Claude needs you", Body: "t", At: at}, {PaneID: "c", Title: "Claude needs you", Body: "t", At: at}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
