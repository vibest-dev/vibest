package core

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

type writeGate struct {
	net.Conn
	armed            atomic.Bool
	entered, release chan struct{}
}

func (g *writeGate) Write(p []byte) (int, error) {
	if g.armed.CompareAndSwap(true, false) {
		close(g.entered)
		<-g.release
	}
	return g.Conn.Write(p)
}

type deliveredInput struct {
	channel uint32
	data    string
}

func queuedClient(t *testing.T) (*Client, *writeGate, <-chan deliveredInput) {
	t.Helper()
	a, b := net.Pipe()
	g := &writeGate{Conn: a, entered: make(chan struct{}), release: make(chan struct{})}
	inputs := make(chan deliveredInput, 16)
	go func() {
		defer b.Close()
		r := bufio.NewReader(b)
		if _, err := r.ReadBytes('\n'); err != nil {
			return
		}
		h := HelloResult{Generation: 1, Version: "0.1.13", Framed: true, Methods: requiredMethods, Features: requiredFeatures}
		h.Core.ID = "queue-fixture"
		payload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": h})
		if writeAll(b, append(payload, '\n')) != nil {
			return
		}
		channel := uint32(0)
		for {
			ch, kind, p, err := readFrame(r)
			if err != nil {
				return
			}
			if ch != 0 {
				if kind == data {
					inputs <- deliveredInput{ch, string(p)}
				}
				continue
			}
			var req struct {
				ID     uint64
				Method string
			}
			if json.Unmarshal(p, &req) != nil {
				return
			}
			var result any = map[string]any{"machines": []any{}}
			if req.Method == "terminal.attach" {
				channel++
				result = map[string]any{"channel": channel, "terminal": Terminal{Address: "t1", State: "live", Cols: 80, Rows: 24}}
			}
			reply, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
			if writeAll(b, frame(0, data, reply)) != nil {
				return
			}
		}
	}()
	c, err := Connect(context.Background(), g)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		select {
		case <-g.release:
		default:
			close(g.release)
		}
		c.Close()
		b.Close()
	})
	return c, g, inputs
}
func queueViewer(t *testing.T, c *Client) *Viewer {
	t.Helper()
	v, err := c.Attach(context.Background(), TerminalAttachParams{Terminal: "t1", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func awaitQueued(t *testing.T, c *Client, n int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for len(c.out) < n {
		if time.Now().After(deadline) {
			t.Fatalf("wanted %d writes actually queued, got %d", n, len(c.out))
		}
		time.Sleep(time.Millisecond)
	}
}
func startInput(i Input, text string) <-chan error {
	done := make(chan error, 1)
	go func() { _, err := i.Write([]byte(text)); done <- err }()
	return done
}
func inputResult(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(time.Second):
		t.Fatal("input did not finish")
		return io.EOF
	}
}

func TestTransportQueuePreservesCapturedOwner(t *testing.T) {
	for _, change := range []string{"focus-return", "attach-replacement", "composition-cancel"} {
		t.Run(change, func(t *testing.T) {
			c, g, wire := queuedClient(t)
			v := queueViewer(t, c)
			replacement := queueViewer(t, c)
			var k Keyboard
			k.Select(v)
			k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
			old, _ := k.CaptureFor(v)
			g.armed.Store(true)
			control := make(chan error, 1)
			go func() { _, err := c.Machines(context.Background()); control <- err }()
			select {
			case <-g.entered:
			case <-time.After(time.Second):
				t.Fatal("control barrier not entered")
			}
			stale := startInput(old, "stale")
			awaitQueued(t, c, 1)
			target := v
			switch change {
			case "focus-return":
				k.Select(nil)
				k.Select(v)
			case "attach-replacement":
				target = replacement
				k.Select(target)
			case "composition-cancel":
				k.Invalidate(v)
			}
			k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
			current, _ := k.CaptureFor(target)
			first := startInput(current, "first")
			awaitQueued(t, c, 2)
			second := startInput(current, "second")
			awaitQueued(t, c, 3)
			close(g.release)
			if err := inputResult(t, stale); !errors.Is(err, ErrOwnership) {
				t.Fatal("stale capture:", err)
			}
			for _, done := range []<-chan error{control, first, second} {
				if err := inputResult(t, done); err != nil {
					t.Fatal(err)
				}
			}
			for _, want := range []string{"first", "second"} {
				select {
				case got := <-wire:
					if got.channel != target.channel || got.data != want {
						t.Fatalf("wire %+v, want %q on %d", got, want, target.channel)
					}
				case <-time.After(time.Second):
					t.Fatal("no current-owner output")
				}
			}
		})
	}
}

func TestAlreadyAdmittedInputIsTheUnrecallableBoundary(t *testing.T) {
	c, g, wire := queuedClient(t)
	v := queueViewer(t, c)
	var k Keyboard
	k.Select(v)
	k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
	old, _ := k.CaptureFor(v)
	g.armed.Store(true)
	admitted := startInput(old, "already-admitted")
	select {
	case <-g.entered:
	case <-time.After(time.Second):
		t.Fatal("input not admitted")
	}
	stale := startInput(old, "still-queued")
	awaitQueued(t, c, 1)
	progress := make(chan struct{})
	go func() {
		k.Deselect(v)
		k.Select(v)
		k.Invalidate(v)
		k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
		close(progress)
	}()
	select {
	case <-progress:
	case <-time.After(time.Second):
		t.Fatal("selection/cancel/paint held behind socket write")
	}
	close(g.release)
	if err := inputResult(t, admitted); err != nil {
		t.Fatal(err)
	}
	if err := inputResult(t, stale); !errors.Is(err, ErrOwnership) {
		t.Fatal(err)
	}
	select {
	case got := <-wire:
		if got.data != "already-admitted" || got.channel != v.channel {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("missing admitted write")
	}
	select {
	case got := <-wire:
		t.Fatalf("queued bytes escaped: %+v", got)
	default:
	}
}

func TestPaintProofRejectsOldSelectionAndGeometryLease(t *testing.T) {
	c, _, _ := queuedClient(t)
	v := queueViewer(t, c)
	var k Keyboard
	k.Select(v)
	built := k.OwnerKey()
	k.Select(nil)
	k.Select(v)
	if k.Rendered(built, 80, 24, 8, 16) {
		t.Fatal("stale frame established readiness after focus returned")
	}
	k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
	old, _ := k.CaptureFor(v)
	k.Rendered(k.OwnerKey(), 100, 30, 8, 16)
	k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
	if old.Valid() {
		t.Fatal("old geometry lease revived when size returned")
	}
	current, _ := k.CaptureFor(v)
	k.Rendered(k.OwnerKey(), 80, 24, 9, 18)
	if current.Valid() {
		t.Fatal("changed pixel cell size retained old geometry lease")
	}
}

func TestViewerControlDoesNotHoldOwnershipDuringSocketWrite(t *testing.T) {
	c, g, _ := queuedClient(t)
	v := queueViewer(t, c)
	var k Keyboard
	k.Select(v)
	g.armed.Store(true)
	done := make(chan error, 1)
	go func() { done <- v.Focus(true) }()
	select {
	case <-g.entered:
	case <-time.After(time.Second):
		t.Fatal("control not admitted")
	}
	progress := make(chan struct{})
	go func() {
		k.Deselect(v)
		k.Select(v)
		k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
		_, _ = k.CaptureFor(v)
		close(progress)
	}()
	select {
	case <-progress:
	case <-time.After(time.Second):
		t.Fatal("control held owner during blocked write")
	}
	close(g.release)
	if err := inputResult(t, done); err != nil {
		t.Fatal(err)
	}
}
func TestCoreCapacityRefusalDoesNotInvalidateInput(t *testing.T) {
	c, g, wire := queuedClient(t)
	v := queueViewer(t, c)
	var k Keyboard
	k.Select(v)
	k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
	owner, _ := k.CaptureFor(v)
	g.armed.Store(true)
	admitted := startInput(owner, "admitted")
	select {
	case <-g.entered:
	case <-time.After(time.Second):
		t.Fatal("not admitted")
	}
	full := make(chan error, 1)
	go func() { _, err := owner.Write(make([]byte, MaxInputBytes)); full <- err }()
	awaitQueued(t, c, 1)
	if _, err := owner.Write([]byte("refused")); !errors.Is(err, ErrBusy) {
		t.Fatalf("want capacity refusal: %v", err)
	}
	if !owner.Valid() {
		t.Fatal("transient capacity invalidated owner")
	}
	close(g.release)
	if err := inputResult(t, admitted); err != nil {
		t.Fatal(err)
	}
	if err := inputResult(t, full); err != nil {
		t.Fatal(err)
	}
	<-wire
	<-wire
	if _, err := owner.Write([]byte("next")); err != nil {
		t.Fatal(err)
	}
	if got := <-wire; got.data != "next" {
		t.Fatal("refused input replayed", got)
	}
}
