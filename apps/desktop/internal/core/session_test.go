package core_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"vibest-desktop/internal/core"
)

func layout() core.Layout {
	l := core.Layout{Schema: 1, CoreID: "fixture-permanent-core"}
	l.AddWorkspace("Workspace", "/mock", "", core.NewPane(core.TerminalRef{CoreID: l.CoreID, Address: "t1"}))
	return l
}
func openSession(t *testing.T, c *core.Client, f *fixture, l any, version uint64) (*core.Session, error) {
	t.Helper()
	go func() {
		q := f.next()
		if q.Method != "events.subscribe" {
			t.Errorf("must subscribe before doc read: %s", q.Method)
		}
		f.reply(q, map[string]any{"channel": 10, "seq": 0, "terminals": []any{map[string]any{"address": "t1", "state": "live"}}})
		q = f.next()
		if q.Method != "doc.get" {
			t.Errorf("method %s", q.Method)
		}
		f.reply(q, map[string]any{"value": l, "version": version})
		if l == "invalid" {
			return
		}
		q = f.next()
		if q.Method != "machine.list" {
			t.Errorf("method %s", q.Method)
		}
		f.reply(q, map[string]any{"machines": []any{}})
	}()
	return core.OpenSession(context.Background(), c)
}
func TestLayoutPersistenceAndConflictNeverOverwritesWinner(t *testing.T) {
	c, f := newFixture(t)
	l := layout()
	s, err := openSession(t, c, f, l, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pane := l.Workspaces[0].Tabs[0].Root.Pane.ID
	changed := core.NewPane(core.TerminalRef{CoreID: l.CoreID, Address: "t2"})
	go func() {
		q := f.next()
		if q.Method != "doc.set" {
			t.Errorf("method %s", q.Method)
		}
		var p struct {
			Name    string
			Version uint64
			Value   core.Layout
		}
		json.Unmarshal(q.Params, &p)
		if p.Name != core.LayoutDocument || p.Version != 1 || p.Value.Workspaces[0].Tabs[0].Root.Second.Pane.ID != changed.ID {
			t.Errorf("wrong CAS: %s", q.Params)
		}
		f.reply(q, map[string]any{"version": 2})
	}()
	if err = s.Edit(context.Background(), func(l *core.Layout) error { return l.SplitPane(pane, "right", changed) }); err != nil {
		t.Fatal(err)
	}
	if got := s.State(); got.Version != 2 || got.Layout.Pane(changed.ID) == nil {
		t.Fatal(got)
	}
	winner := layout()
	winner.Workspaces[0].Label = "Other window"
	go func() {
		q := f.next()
		f.sendJSON(0, map[string]any{"jsonrpc": "2.0", "id": q.ID, "error": map[string]any{"code": -32000, "message": "version is 3", "data": map[string]string{"kind": "conflict"}}}, false)
		q = f.next()
		if q.Method != "doc.get" {
			t.Errorf("conflict must refetch, not retry: %s", q.Method)
		}
		f.reply(q, map[string]any{"value": winner, "version": 3})
		q = f.next()
		f.reply(q, map[string]any{"machines": []any{}})
	}()
	err = s.Edit(context.Background(), func(l *core.Layout) error { l.Workspaces[0].Label = "stale edit"; return nil })
	var rpc *core.RPCError
	if !errors.As(err, &rpc) || rpc.Data.Kind != "conflict" {
		t.Fatal(err)
	}
	state := s.State()
	if state.Version != 3 || state.Layout.Workspaces[0].Label != "Other window" {
		t.Fatal(state)
	}
	select {
	case q := <-f.requests:
		t.Fatalf("unexpected retry %s", q.Method)
	default:
	}
	state.Layout.Workspaces[0].Label = "alias"
	if s.State().Layout.Workspaces[0].Label == "alias" {
		t.Fatal("state aliases store")
	}
}
func TestLostAttachAndReconnectDoNotRetarget(t *testing.T) {
	c, f := newFixture(t)
	l := layout()
	s, err := openSession(t, c, f, l, 1)
	if err != nil {
		t.Fatal(err)
	}
	pane := l.Workspaces[0].Tabs[0].Root.Pane.ID
	go func() {
		q := f.next()
		f.reply(q, map[string]any{"channel": 11, "terminal": map[string]any{"address": "t1", "state": "live"}})
	}()
	v, err := s.Attach(context.Background(), pane, core.AttachOptions{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	var k core.Keyboard
	k.Select(v)
	k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
	old, _ := k.Capture()
	event := map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"seq": 1, "type": "lost", "terminal": "t1", "data": map[string]any{"reason": "holder_lost", "exit_code": nil}}}
	b, _ := json.Marshal(event)
	f.send(10, 0, append(b, '\n'))
	if p := f.nextFrame(2); p.channel != 11 {
		t.Fatal(p)
	}
	if _, err = old.Write([]byte("must not reach kept replacement")); !errors.Is(err, core.ErrOwnership) {
		t.Fatal(err)
	}
	s.Close()
	select {
	case <-s.Done():
	case <-time.After(time.Second):
		t.Fatal("session did not cancel")
	}
	c2, f2 := newFixture(t)
	s2, err := openSession(t, c2, f2, l, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if c.Hello().Core.ID != c2.Hello().Core.ID {
		t.Fatal("test must reuse permanent identity")
	}
	if _, err = old.Write([]byte("must not cross connection")); !errors.Is(err, core.ErrOwnership) && !errors.Is(err, core.ErrClosed) {
		t.Fatal(err)
	}
	if !s2.State().Connected {
		t.Fatal("new session unavailable")
	}
}
func TestMissedRefetchesDocumentAndUnknownStatusRemainsUnknown(t *testing.T) {
	c, f := newFixture(t)
	l := layout()
	s, err := openSession(t, c, f, l, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.State().Terminals["t1"].Activity() != "unknown" {
		t.Fatal("invented status")
	}
	winner := layout()
	winner.Workspaces[0].Label = "While disconnected"
	go func() {
		q := f.next()
		if q.Method != "doc.get" {
			t.Errorf("missed needs doc.get: %s", q.Method)
		}
		f.reply(q, map[string]any{"value": winner, "version": 9})
		q = f.next()
		f.reply(q, map[string]any{"machines": []any{}})
	}()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "missed", "params": map[string]any{"seq": 20, "terminals": []any{map[string]any{"address": "t2", "state": "live"}}}})
	f.send(10, 0, append(b, '\n'))
	deadline := time.After(time.Second)
	for s.State().Version != 9 {
		select {
		case <-s.Changes():
		case <-deadline:
			t.Fatal("document not reloaded")
		}
	}
	state := s.State()
	if len(state.Terminals) != 1 || state.Terminals["t2"].Activity() != "unknown" {
		t.Fatal(state)
	}
}
func TestUnknownDocumentSchemaRefusedWithoutWrite(t *testing.T) {
	c, f := newFixture(t)
	go func() {
		q := f.next()
		f.reply(q, map[string]any{"channel": 10, "seq": 0, "terminals": []any{}})
		q = f.next()
		f.reply(q, map[string]any{"value": map[string]any{"schema": 99, "core_id": "fixture-permanent-core"}, "version": 7})
	}()
	if _, err := core.OpenSession(context.Background(), c); err == nil {
		t.Fatal("accepted unknown schema")
	}
	select {
	case q := <-f.requests:
		t.Fatalf("unexpected write %s", q.Method)
	default:
	}
}
func TestSelectionIsLocalAndPaneMovePreservesTerminal(t *testing.T) {
	l := layout()
	w := l.Workspaces[0]
	first := w.Tabs[0].Root.Pane.ID
	second := core.NewPane(core.TerminalRef{CoreID: l.CoreID, Address: "t2"})
	tab, err := l.AddTab(w.ID, "second", second)
	if err != nil {
		t.Fatal(err)
	}
	var a, b core.Selection
	a.Reconcile(&l)
	b.Reconcile(&l)
	if err = a.SelectTab(&l, tab); err != nil {
		t.Fatal(err)
	}
	if a.Tab == b.Tab || b.Pane != first {
		t.Fatal("window focus was shared")
	}
	if err = a.ToggleZoom(&l, second.ID); err != nil {
		t.Fatal(err)
	}
	if a.Zoom != second.ID || b.Zoom != "" {
		t.Fatal("zoom was shared")
	}
	moved, err := l.MovePane(first, w.ID, tab)
	if err != nil || moved != tab {
		t.Fatal(moved, err)
	}
	if err = l.Validate(l.CoreID); err != nil {
		t.Fatal(err)
	}
	if l.Pane(first).Terminal.Address != "t1" {
		t.Fatal("moving pane changed terminal")
	}
	b.Reconcile(&l)
	if b.Tab != tab || b.Pane == "" {
		t.Fatal("selection failed to reconcile removed source tab")
	}
	if err = l.RemovePane(second.ID); err != nil {
		t.Fatal(err)
	}
	a.Reconcile(&l)
	if a.Zoom != "" || a.Pane != first {
		t.Fatal("selection retained removed pane")
	}
}

func TestLayoutOperationsKeepFrontendAndTerminalIdentityDistinct(t *testing.T) {
	l := layout()
	w := l.Workspaces[0]
	tab := w.Tabs[0]
	pane := tab.Root.Pane
	second := core.NewPane(core.TerminalRef{CoreID: l.CoreID, Address: "t2"})
	if err := l.SplitPane(pane.ID, "down", second); err != nil {
		t.Fatal(err)
	}
	if err := l.SetRatio(tab.ID, nil, .65); err != nil {
		t.Fatal(err)
	}
	if err := l.SwapPanes(pane.ID, second.ID); err != nil {
		t.Fatal(err)
	}
	third := core.NewPane(core.TerminalRef{CoreID: l.CoreID, Address: "t3"})
	tab2, err := l.AddTab(w.ID, "other", third)
	if err != nil {
		t.Fatal(err)
	}
	if err = l.MoveTab(tab2, 0); err != nil {
		t.Fatal(err)
	}
	if l.Workspaces[0].Tabs[0].ID != tab2 {
		t.Fatal("tab not moved")
	}
	if err = l.RemovePane(second.ID); err != nil {
		t.Fatal(err)
	}
	if err = l.Validate(l.CoreID); err != nil {
		t.Fatal(err)
	}
	if l.Pane(pane.ID).Terminal.Address != "t1" || pane.ID == "t1" {
		t.Fatal("identity conflation")
	}
	if err = l.RemovePane(pane.ID); err != nil {
		t.Fatal(err)
	}
	if len(l.Workspaces[0].Tabs) != 1 {
		t.Fatal("empty tab retained")
	}
	if err = l.RemovePane(third.ID); err != nil {
		t.Fatal(err)
	}
	if len(l.Workspaces) != 0 {
		t.Fatal("empty workspace retained")
	}
}

func TestMachinesAreReadOnConnectAndOnRemoteTerminalEventsNeverOnATimer(t *testing.T) {
	c, f := newFixture(t)
	s, err := openSession(t, c, f, layout(), 1)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	select {
	case q := <-f.requests:
		t.Fatalf("an idle session sent %s", q.Method)
	case <-time.After(300 * time.Millisecond):
	}
	event := map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"seq": 1, "type": "lost", "terminal": "box/t9", "machine": "box", "data": map[string]any{"reason": "holder_lost", "exit_code": nil}}}
	b, _ := json.Marshal(event)
	f.send(10, 0, append(b, '\n'))
	q := f.next()
	if q.Method != "machine.list" {
		t.Fatalf("method %s", q.Method)
	}
	f.reply(q, map[string]any{"machines": []any{map[string]any{"name": "box", "state": "disconnected"}}})
	deadline := time.Now().Add(3 * time.Second)
	for len(s.State().Machines) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("machines not refreshed")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
