package herdr

import (
	"bufio"
	"errors"
	"io"
	"net"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type ownerWriteConn struct {
	net.Conn
	writes      int
	fail        bool
	short       bool
	deadlineErr error
}

func (c *ownerWriteConn) SetWriteDeadline(time.Time) error { return c.deadlineErr }
func (c *ownerWriteConn) Write(b []byte) (int, error) {
	c.writes++
	if c.short {
		return 0, nil
	}
	if c.fail {
		c.fail = false
		return 0, errors.New("owned zero-byte failure")
	}
	return len(b), nil
}

func TestInputOwnedRequiresTrustedNonemptyBoot(t *testing.T) {
	c := &ownerWriteConn{}
	s := &Shell{conn: c, snap: &ShellSnapshot{Boot: "known"}}
	for _, boot := range []string{"", "other"} {
		if err := s.InputOwned(Target{ID: "a"}, boot, func() bool { return true }, Text("x")); !errors.Is(err, ErrInputInvalidated) || c.writes != 0 {
			t.Fatal("untrusted owner admitted", err, c.writes)
		}
	}
	s.snap = nil
	if err := s.InputOwned(Target{ID: "a"}, "known", func() bool { return true }, Text("x")); !errors.Is(err, ErrInputInvalidated) || c.writes != 0 {
		t.Fatal("missing trusted snapshot admitted", err, c.writes)
	}
	s.snap = &ShellSnapshot{}
	if err := s.InputOwned(Target{ID: "a"}, "", func() bool { return true }, Text("x")); !errors.Is(err, ErrInputInvalidated) || c.writes != 0 {
		t.Fatal("two empty identities matched", err, c.writes)
	}
	s.snap = &ShellSnapshot{Boot: "known"}
	if err := s.InputOwned(Target{ID: "a"}, "known", func() bool { return true }, Text("q")); err != nil || c.writes != 1 {
		t.Fatal("invalid caller poisoned healthy owner", err, c.writes)
	}
}

func TestMalformedBootProtocolClosesWithoutPublishing(t *testing.T) {
	for _, kind := range []string{"snapshot-missing", "snapshot-empty", "surface-empty"} {
		t.Run(kind, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			defer server.Close()
			published := false
			s := &Shell{conn: client, reader: bufio.NewReader(client), response: make(chan []byte, 1), ready: make(chan struct{}), OnSnapshot: func(*ShellSnapshot) { published = true }, OnSurface: func(*Surface) { published = true }}
			done := make(chan error, 1)
			go func() { done <- s.Run() }()
			f := &fakeHerdr{t: t, conn: server}
			if kind == "surface-empty" {
				f.surface("", 1, 1, "x")
			} else if kind == "snapshot-empty" {
				f.snapshot("", 1)
			} else {
				f.control(snapKind, `{"revision":1}`)
			}
			select {
			case err := <-done:
				if err == nil || !strings.Contains(err.Error(), "boot identity") {
					t.Fatal("missing malformed-identity error", err)
				}
			case <-time.After(time.Second):
				t.Fatal("malformed identity did not end connection")
			}
			if published {
				t.Fatal("untrusted decoded state published")
			}
		})
	}
}

func TestInputOwnedChecksAfterWaitingForTransport(t *testing.T) {
	for _, change := range []string{"boot", "connection"} {
		t.Run(change, func(t *testing.T) {
			c := &ownerWriteConn{}
			s := &Shell{conn: c, snap: &ShellSnapshot{Boot: "old"}}
			var valid atomic.Bool
			valid.Store(true)
			s.wmu.Lock()
			done := make(chan error, 1)
			go func() { done <- s.InputOwned(Target{ID: "a"}, "old", valid.Load, Text("x")) }()
			waiting := false
			deadline := time.Now().Add(2 * time.Second)
			trace := make([]byte, 64<<10)
			for !waiting && time.Now().Before(deadline) {
				for _, g := range strings.Split(string(trace[:runtime.Stack(trace, true)]), "\n\n") {
					if strings.Contains(g, "TestInputOwnedChecksAfterWaitingForTransport.func") && strings.Contains(g, "(*Shell).sendIf") && strings.Contains(g, ".lockSlow") {
						waiting = true
						break
					}
				}
				runtime.Gosched()
			}
			if !waiting {
				s.wmu.Unlock()
				t.Fatal("owned job never reached the transport writer wait")
			}
			if change == "boot" {
				s.mu.Lock()
				s.snap = &ShellSnapshot{Boot: "new"}
				s.mu.Unlock()
			} else {
				valid.Store(false)
			}
			s.wmu.Unlock()
			select {
			case err := <-done:
				if !errors.Is(err, ErrInputInvalidated) {
					t.Fatalf("post-wait error=%v writes=%d", err, c.writes)
				}
			case <-time.After(time.Second):
				t.Fatal("write admission blocked")
			}
			if c.writes != 0 {
				t.Fatal("stale owner entered transport")
			}
			valid.Store(true)
			boot := "old"
			if change == "boot" {
				boot = "new"
			}
			if err := s.InputOwned(Target{ID: "a"}, boot, valid.Load, Text("q")); err != nil {
				t.Fatal(err)
			}
			if c.writes != 1 {
				t.Fatal("ownership rejection poisoned fresh owner")
			}
			if err := s.InputOwned(Target{ID: "a"}, boot, nil, Text("bad")); !errors.Is(err, ErrInputInvalidated) || c.writes != 1 {
				t.Fatal("nil owner was admitted")
			}
		})
	}
}

func TestFailedTransportCannotResumeUnderAnotherOwner(t *testing.T) {
	c := &ownerWriteConn{fail: true}
	s := &Shell{conn: c, snap: &ShellSnapshot{Boot: "old"}}
	if err := s.InputOwned(Target{ID: "a"}, "old", func() bool { return true }, Text("x")); err == nil {
		t.Fatal("missing injected error")
	}
	s.mu.Lock()
	s.snap = &ShellSnapshot{Boot: "new"}
	s.mu.Unlock()
	if err := s.InputOwned(Target{ID: "a"}, "new", func() bool { return true }, Key{Code: KeyEnter}); err == nil {
		t.Fatal("failed physical connection resumed")
	}
	if c.writes != 1 {
		t.Fatal("missing prefix released another write")
	}
}

func TestShortTransportWriteIsFailedNotDelivered(t *testing.T) {
	c := &ownerWriteConn{short: true}
	s := &Shell{conn: c}
	if err := s.Input(Target{ID: "a"}, Text("x")); !errors.Is(err, io.ErrShortWrite) {
		t.Fatal(err)
	}
	c.short = false
	if err := s.Input(Target{ID: "a"}, Key{Code: KeyEnter}); !errors.Is(err, io.ErrShortWrite) || c.writes != 1 {
		t.Fatal("short prefix released Enter")
	}
}

func TestDeadlineFailureNeverAdmitsInput(t *testing.T) {
	c := &ownerWriteConn{deadlineErr: errors.New("fixture deadline failure")}
	s := &Shell{conn: c}
	if err := s.Input(Target{ID: "a"}, Text("x")); err == nil {
		t.Fatal("deadline failure ignored")
	}
	c.deadlineErr = nil
	if err := s.Input(Target{ID: "a"}, Key{Code: KeyEnter}); err == nil || c.writes != 0 {
		t.Fatal("deadline failure admitted a trailing write")
	}
}

func TestPublishRejectsOldBootSurfaceWithReusedRevision(t *testing.T) {
	called := false
	s := &Shell{snap: &ShellSnapshot{Boot: "new", Revision: 1}, surface: &Surface{Boot: "old", Projection: 1}, unshown: true, OnSurface: func(*Surface) { called = true }}
	s.publish()
	if called {
		t.Fatal("old boot surface published under reused revision")
	}
}
