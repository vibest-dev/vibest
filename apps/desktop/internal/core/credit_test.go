package core_test

import (
	"encoding/binary"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibest-desktop/internal/core"
)

type creditGateConn struct {
	net.Conn
	enabled           atomic.Bool
	entered, release  chan struct{}
	once, releaseOnce sync.Once
}

func (g *creditGateConn) Write(p []byte) (int, error) {
	if g.enabled.Load() {
		g.once.Do(func() { close(g.entered) })
		<-g.release
	}
	return g.Conn.Write(p)
}
func (g *creditGateConn) unblock() { g.releaseOnce.Do(func() { close(g.release) }) }
func TestSmallReadsCoalesceCreditWithoutDisconnectingOtherViewers(t *testing.T) {
	var gate *creditGateConn
	c, f := newFixtureWithConn(t, func(conn net.Conn) net.Conn {
		gate = &creditGateConn{Conn: conn, entered: make(chan struct{}), release: make(chan struct{})}
		return gate
	})
	t.Cleanup(gate.unblock)
	a, b := attach(t, c, f, "t1", 1), attach(t, c, f, "t2", 2)
	f.send(1, 0, make([]byte, 256))
	gate.enabled.Store(true)
	var p [1]byte
	if _, err := a.Read(p[:]); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gate.entered:
	case <-time.After(time.Second):
		t.Fatal("writer not paused")
	}
	for i := 0; i < 129; i++ {
		if _, err := a.Read(p[:]); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Err(); err != nil {
		t.Fatalf("130 legitimate small reads disconnected both viewers: %v", err)
	}
	f.send(2, 0, []byte("peer"))
	read(t, b, "peer")
	for i := 0; i < 126; i++ {
		if _, err := a.Read(p[:]); err != nil {
			t.Fatal(err)
		}
	}
	gate.unblock()
	totals := map[uint32]uint32{}
	for totals[1] < 256 || totals[2] < 4 {
		p := f.nextFrame(1)
		totals[p.channel] += binary.LittleEndian.Uint32(p.body)
	}
	if totals[1] != 256 || totals[2] != 4 {
		t.Fatal("lost or duplicated credit", totals)
	}
	var k core.Keyboard
	k.Select(b)
	k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
	input, ok := k.Capture()
	if !ok {
		t.Fatal("second viewer lost input")
	}
	if _, err := input.Write([]byte("next")); err != nil {
		t.Fatal(err)
	}
	if p := f.nextFrame(0); p.channel != 2 || string(p.body) != "next" {
		t.Fatal(p)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	if p := f.nextFrame(2); p.channel != 1 {
		t.Fatal(p)
	}
	if c.Err() != nil {
		t.Fatal(c.Err())
	}
}

func TestPendingCreditRetiresBeforeCloseAndLaterApplicationInput(t *testing.T) {
	var gate *creditGateConn
	c, f := newFixtureWithConn(t, func(conn net.Conn) net.Conn {
		gate = &creditGateConn{Conn: conn, entered: make(chan struct{}), release: make(chan struct{})}
		return gate
	})
	t.Cleanup(gate.unblock)
	a, b := attach(t, c, f, "t1", 1), attach(t, c, f, "t2", 2)
	f.send(1, 0, make([]byte, 256))
	gate.enabled.Store(true)
	var byteBuffer [1]byte
	a.Read(byteBuffer[:])
	select {
	case <-gate.entered:
	case <-time.After(time.Second):
		t.Fatal("writer not paused")
	}
	for i := 0; i < 129; i++ {
		if _, err := a.Read(byteBuffer[:]); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	gate.unblock()
	var k core.Keyboard
	k.Select(b)
	k.Rendered(k.OwnerKey(), 80, 24, 8, 16)
	input, _ := k.Capture()
	if _, err := input.Write([]byte("after close")); err != nil {
		t.Fatal(err)
	}
	closed := false
	credits := uint32(0)
	for {
		select {
		case p := <-f.frames:
			switch p.kind {
			case 1:
				if closed && p.channel == 1 {
					t.Fatal("credit after CLOSE")
				}
				credits += binary.LittleEndian.Uint32(p.body)
			case 2:
				if p.channel != 1 {
					t.Fatal(p)
				}
				closed = true
			case 0:
				if !closed || p.channel != 2 || string(p.body) != "after close" || credits != 1 {
					t.Fatalf("wrong order/credit: closed=%v credit=%d frame=%v", closed, credits, p)
				}
				return
			}
		case <-time.After(time.Second):
			t.Fatal("writer did not drain")
		}
	}
}
