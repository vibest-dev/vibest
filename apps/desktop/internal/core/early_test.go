package core_test

import (
	"context"
	"errors"
	"io"
	"testing"

	"vibest-desktop/internal/core"
)

func unavailable(f *fixture, q request) {
	f.sendJSON(0, map[string]any{"jsonrpc": "2.0", "id": q.ID, "error": map[string]any{"code": -32000, "message": "unavailable", "data": map[string]string{"kind": "unavailable"}}}, false)
}
func TestEarlyCloseOnSuccessiveFailedAttaches(t *testing.T) {
	c, f := newFixture(t)
	other := attach(t, c, f, "local", 50)
	for ch := uint32(1); ch <= 2; ch++ {
		go func(ch uint32) { q := f.next(); f.send(ch, 2, nil); unavailable(f, q) }(ch)
		_, err := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: "rohan/t1", Cols: 80, Rows: 24})
		var rpc *core.RPCError
		if !errors.As(err, &rpc) {
			t.Fatalf("attempt %d: want independent RPC error, got %v; connection %v", ch, err, c.Err())
		}
	}
	f.send(50, 0, []byte("still alive"))
	read(t, other, "still alive")
	if c.Err() != nil {
		t.Fatal(c.Err())
	}
}
func TestConcurrentEarlyChannelsMatchReverseReplies(t *testing.T) {
	for _, closed := range []bool{false, true} {
		t.Run(map[bool]string{false: "live", true: "closed"}[closed], func(t *testing.T) {
			c, f := newFixture(t)
			type answer struct {
				v   *core.Viewer
				err error
			}
			a, b := make(chan answer, 1), make(chan answer, 1)
			go func() {
				v, e := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: "t1", Cols: 80, Rows: 24})
				a <- answer{v, e}
			}()
			qa := f.next()
			go func() {
				v, e := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: "t2", Cols: 80, Rows: 24})
				b <- answer{v, e}
			}()
			qb := f.next()
			f.send(7, 0, []byte("A"))
			if closed {
				f.send(7, 2, nil)
			}
			f.send(8, 0, []byte("B"))
			f.reply(qb, map[string]any{"channel": 8, "terminal": map[string]any{"address": "t2"}})
			f.reply(qa, map[string]any{"channel": 7, "terminal": map[string]any{"address": "t1"}})
			av, bv := <-a, <-b
			if av.err != nil || bv.err != nil {
				t.Fatal(av.err, bv.err)
			}
			read(t, av.v, "A")
			read(t, bv.v, "B")
			if closed {
				var p [1]byte
				if _, err := av.v.Read(p[:]); err != io.EOF {
					t.Fatal(err)
				}
			}
		})
	}
}
func TestClosedEarlySuccessSurvivesAnotherFailedReply(t *testing.T) {
	c, f := newFixture(t)
	result := make(chan *core.Viewer, 1)
	go func() {
		v, err := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: "t1", Cols: 80, Rows: 24})
		if err != nil {
			t.Error(err)
		}
		result <- v
	}()
	success := f.next()
	failed := make(chan error, 1)
	go func() {
		_, err := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: "bad/t2", Cols: 80, Rows: 24})
		failed <- err
	}()
	failure := f.next()
	f.send(7, 0, []byte("final output"))
	f.send(7, 2, nil)
	f.send(8, 2, nil)
	unavailable(f, failure)
	if err := <-failed; err == nil {
		t.Fatal("missing failure")
	}
	f.reply(success, map[string]any{"channel": 7, "terminal": map[string]any{"address": "t1"}})
	v := <-result
	if v == nil {
		t.Fatal("lost closed success")
	}
	read(t, v, "final output")
	attach(t, c, f, "t3", 9)
}

func TestUnmatchedClosedBudgetRefusesNewOpenWithoutDisconnect(t *testing.T) {
	c, f := newFixture(t)
	other := attach(t, c, f, "other", 500)
	pending := make(chan error, 1)
	go func() {
		_, err := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: "pending", Cols: 80, Rows: 24})
		pending <- err
	}()
	last := f.next()
	for ch := uint32(1); ch <= 126; ch++ {
		go func(ch uint32) { q := f.next(); f.send(ch, 2, nil); unavailable(f, q) }(ch)
		if _, err := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: "failed", Cols: 80, Rows: 24}); err == nil {
			t.Fatal("missing failure")
		}
	}
	refused := make(chan error, 1)
	go func() {
		_, err := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: "too many", Cols: 80, Rows: 24})
		refused <- err
	}()
	select {
	case err := <-refused:
		if !errors.Is(err, core.ErrBusy) {
			t.Fatal(err)
		}
	case q := <-f.requests:
		unavailable(f, q)
		<-refused
		t.Fatal("dispatched an open without room to retain its early channel")
	}
	f.reply(last, map[string]any{"channel": 501, "terminal": map[string]any{"address": "pending"}})
	if err := <-pending; err != nil {
		t.Fatal(err)
	}
	attach(t, c, f, "after retirement", 502)
	f.send(500, 0, []byte("unrelated survives"))
	read(t, other, "unrelated survives")
}
