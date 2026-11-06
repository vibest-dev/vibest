package app

import (
	"strings"
	"testing"
	"time"
)

func TestAnUnfocusedTerminalAnswersItsProgramsQuery(t *testing.T) {
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "split")
	focused := readyCorePane(t, a, tt, "a")
	coreOutput(t, a, f, tt, "b", "\x1b[?9001l")
	a.mu.Lock()
	unfocused := a.coreViews["b"]
	a.mu.Unlock()
	if unfocused == focused || unfocused.InputReady() {
		t.Fatal("pane b must not own the keyboard")
	}
	f.mu.Lock()
	channel := f.channels["b"]
	f.mu.Unlock()
	coreOutput(t, a, f, tt, "b", "\x1b[c")
	deadline := time.After(2 * time.Second)
	for {
		select {
		case p := <-f.inputs:
			if p.channel == channel && strings.HasPrefix(string(p.body), "\x1b[?") && strings.HasSuffix(string(p.body), "c") {
				return
			}
			t.Fatalf("unexpected input on %d: %q", p.channel, p.body)
		case <-deadline:
			t.Fatal("the unfocused terminal did not answer its program's device attributes query")
		case <-time.After(time.Millisecond):
			tt.Frame()
		}
	}
}
