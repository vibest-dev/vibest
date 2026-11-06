package core_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"vibest-desktop/internal/core"
)

func remoteSession(t *testing.T, c *core.Client, f *fixture) (*core.Session, string) {
	l := core.Layout{Schema: 1, CoreID: c.Hello().Core.ID}
	p := core.NewPane(core.TerminalRef{CoreID: "remote-A", Address: "rohan/t1"})
	l.AddWorkspace("Remote", "/mock", "rohan", p)
	go func() {
		q := f.next()
		f.reply(q, map[string]any{"channel": 10, "seq": 0, "terminals": []any{map[string]any{"address": "rohan/t1", "state": "live"}}})
		q = f.next()
		f.reply(q, map[string]any{"value": l, "version": 1})
		q = f.next()
		f.reply(q, map[string]any{"machines": []any{map[string]any{"name": "rohan", "id": "remote-A", "state": "connected"}}})
	}()
	s, err := core.OpenSession(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	return s, p.ID
}
func TestRemoteAliasReassignmentCannotRetargetPinnedAttach(t *testing.T) {
	c, f := newFixture(t)
	s, pane := remoteSession(t, c, f)
	got := make(chan string, 1)
	go func() {
		q := f.next()
		var p struct{ Terminal string }
		json.Unmarshal(q.Params, &p)
		got <- p.Terminal
		if p.Terminal == "rohan/t1" {
			f.reply(q, map[string]any{"channel": 11, "terminal": map[string]any{"address": "rohan/t1", "state": "live"}})
		} else {
			unavailable(f, q)
		}
	}()
	v, err := s.Attach(context.Background(), pane, core.AttachOptions{Cols: 80, Rows: 24})
	wire := <-got
	if wire != "remote-A/t1" || err == nil || v != nil {
		t.Fatalf("pinned A admitted replacement B: wire=%q viewer=%v error=%v", wire, v, err)
	}
}

func TestPinnedRemoteRunKillAndRenamedAttach(t *testing.T) {
	c, f := newFixture(t)
	s, pane := remoteSession(t, c, f)
	state := s.State()
	ref := state.Layout.Pane(pane).Terminal
	go func() {
		q := f.next()
		var p core.RunOptions
		json.Unmarshal(q.Params, &p)
		if q.Method != "terminal.run" || p.On != "remote-A" {
			t.Errorf("run not pinned: %s %s", q.Method, q.Params)
		}
		f.reply(q, map[string]any{"address": "renamed/t2", "state": "live"})
	}()
	record, created, err := s.Run(context.Background(), core.RunOptions{On: "remote-A"})
	if err != nil || created.CoreID != "remote-A" || created.Address != record.Address {
		t.Fatal(record, created, err)
	}
	if _, _, err := s.Run(context.Background(), core.RunOptions{On: "rohan"}); err == nil {
		t.Fatal("session Run accepted mutable alias")
	}
	go func() {
		q := f.next()
		var p struct{ Terminal string }
		json.Unmarshal(q.Params, &p)
		if q.Method != "terminal.kill" || p.Terminal != "remote-A/t1" {
			t.Errorf("kill not pinned: %s %s", q.Method, q.Params)
		}
		unavailable(f, q)
	}()
	if err := s.Kill(context.Background(), ref); err == nil {
		t.Fatal("missing original Core must fail, not kill its alias replacement")
	}
	go func() {
		q := f.next()
		var p struct{ Terminal string }
		json.Unmarshal(q.Params, &p)
		if p.Terminal != "remote-A/t1" {
			t.Errorf("attach not pinned: %s", q.Params)
		}
		f.reply(q, map[string]any{"channel": 11, "terminal": map[string]any{"address": "renamed/t1", "state": "live"}})
	}()
	v, err := s.Attach(context.Background(), pane, core.AttachOptions{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	state = s.State()
	if v.Terminal.Address != "renamed/t1" || state.Layout.Pane(pane).Terminal != ref {
		t.Fatal("presentation rewrote the stored identity")
	}
	go func() { q := f.next(); f.reply(q, map[string]any{"version": 2}) }()
	if err := s.Edit(context.Background(), func(l *core.Layout) error { return l.Rename(pane, "name") }); err != nil {
		t.Fatal(err)
	}
	f.send(11, 0, []byte("pinned output"))
	read(t, v, "pinned output")
}

func TestRemoteRelayCannotAdmitInputBeforeItsLateMissedFence(t *testing.T) {
	c, f := newFixture(t)
	s, pane := remoteSession(t, c, f)
	go func() {
		q := f.next()
		f.reply(q, map[string]any{"channel": 11, "terminal": map[string]any{"address": "rohan/t1", "state": "live", "cols": 80, "rows": 24}})
	}()
	v, err := s.Attach(context.Background(), pane, core.AttachOptions{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	var k core.Keyboard
	k.Select(v)
	k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
	old, ready := k.Capture()
	const output = "\r\n[line to rohan lost; reconnecting...]\r\n\x1b[2Jnew shell\x1b[?9001l"
	f.send(11, 0, []byte(output))
	read(t, v, output)
	if n, err := old.Write([]byte("stale")); err == nil {
		t.Fatalf("pre-gap capture wrote %d bytes into replacement", n)
	}
	if ready {
		t.Fatal("remote input must be explicitly unsupported from the start")
	}
	if !errors.Is(v.InputError(), core.ErrRemoteInput) {
		t.Fatal("missing explicit unsupported reason", v.InputError())
	}
	k.Select(nil)
	k.Select(v)
	k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
	if _, ok := k.CaptureFor(v); ok {
		t.Fatal("remote input revived")
	}
	local := attach(t, c, f, "t9", 12)
	k.Select(local)
	k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
	input, ok := k.Capture()
	if !ok {
		t.Fatal("local input disabled")
	}
	if _, err := input.Write([]byte("local works")); err != nil {
		t.Fatal(err)
	}
	if p := f.nextFrame(0); p.channel != 12 || string(p.body) != "local works" {
		t.Fatal(p)
	}
}
