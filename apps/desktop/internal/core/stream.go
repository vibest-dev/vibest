package core

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
)

type Stream struct {
	client     *Client
	channel    uint32
	mu         sync.Mutex
	chunks     [][]byte
	buffered   int
	creditDebt uint32
	err        error
	reason     json.RawMessage
	wake       chan struct{}
}

func (s *Stream) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
func (s *Stream) feed(b []byte) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return true
	}
	if s.buffered+int(s.creditDebt)+len(b) > streamWindow {
		return false
	}
	if len(b) > 0 {
		s.chunks = append(s.chunks, b)
		s.buffered += len(b)
		s.signal()
	}
	return true
}
func (s *Stream) end(err error, reason []byte) {
	s.mu.Lock()
	if s.err == nil {
		s.err = err
		s.creditDebt = 0
		s.reason = append([]byte(nil), reason...)
	}
	s.signal()
	s.mu.Unlock()
}
func (s *Stream) alive() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.err == nil }
func (s *Stream) Reason() json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append(json.RawMessage(nil), s.reason...)
}
func (s *Stream) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	for {
		s.mu.Lock()
		if len(s.chunks) > 0 {
			n := copy(b, s.chunks[0])
			s.chunks[0] = s.chunks[0][n:]
			s.buffered -= n
			if len(s.chunks[0]) == 0 {
				s.chunks[0] = nil
				s.chunks = s.chunks[1:]
			}
			ended := s.err != nil
			if !ended {
				s.creditDebt += uint32(n)
			}
			s.mu.Unlock()
			if !ended {
				select {
				case s.client.creditWake <- struct{}{}:
				default:
				}
			}
			return n, nil
		}
		err := s.err
		s.mu.Unlock()
		if err != nil {
			return 0, err
		}
		select {
		case <-s.wake:
		case <-s.client.done:
			return 0, s.client.Err()
		}
	}
}
func (s *Stream) Close() error {
	s.mu.Lock()
	closed := s.err != nil
	s.err = ErrClosed
	s.chunks = nil
	s.buffered = 0
	s.creditDebt = 0
	s.signal()
	s.mu.Unlock()
	if closed {
		return nil
	}
	c := s.client
	c.mu.Lock()
	delete(c.streams, s.channel)
	c.mu.Unlock()
	if err := c.enqueue(outgoing{ctx: context.Background(), bytes: frame(s.channel, closeChannel, nil)}); err != nil {
		c.fail(err)
		return err
	}
	return nil
}

type Display struct {
	FG     string     `json:"fg,omitempty"`
	BG     string     `json:"bg,omitempty"`
	Cursor string     `json:"cursor,omitempty"`
	Cell   *[2]uint32 `json:"cell,omitempty"`
}
type AttachOptions struct {
	Terminal string  `json:"terminal"`
	Cols     uint16  `json:"cols"`
	Rows     uint16  `json:"rows"`
	History  uint32  `json:"history,omitempty"`
	Observe  bool    `json:"observe,omitempty"`
	Resumed  bool    `json:"resumed,omitempty"`
	Display  Display `json:"display"`
}

type Viewer struct {
	*Stream
	Terminal Terminal
	observe  bool
	remote   bool
	ref      TerminalRef
}

func (c *Client) Attach(ctx context.Context, o AttachOptions) (*Viewer, error) {
	if o.Terminal == "" || o.Cols == 0 || o.Rows == 0 {
		return nil, errors.New("core: terminal and positive attach size required")
	}
	var r struct {
		Terminal Terminal `json:"terminal"`
	}
	s, err := c.call(ctx, "terminal.attach", o, &r, true)
	if err != nil {
		return nil, err
	}
	if r.Terminal.Address == "" {
		s.Close()
		return nil, errors.New("core: attach omitted terminal identity")
	}
	prefix, _, qualified := strings.Cut(o.Terminal, "/")
	remote := qualified && prefix != c.hello.Core.ID && prefix != c.hello.Core.Name
	returned, _, qualified := strings.Cut(r.Terminal.Address, "/")
	remote = remote || (qualified && returned != c.hello.Core.ID && returned != c.hello.Core.Name)
	return &Viewer{Stream: s, Terminal: r.Terminal, observe: o.Observe, remote: remote}, nil
}

func (v *Viewer) InputError() error {
	if v.remote {
		return ErrRemoteInput
	}
	return nil
}

func (v *Viewer) Resize(cols, rows int) error {
	if cols < 1 || rows < 1 || cols > 65535 || rows > 65535 {
		return errors.New("core: invalid viewer size")
	}
	var b [4]byte
	binary.LittleEndian.PutUint16(b[:], uint16(cols))
	binary.LittleEndian.PutUint16(b[2:], uint16(rows))
	return v.control(resize, b[:])
}
func (v *Viewer) Focus(focused bool) error {
	b := byte(0)
	if focused {
		b = 1
	}
	return v.control(focus, []byte{b})
}
func (v *Viewer) SetDisplay(d Display) error {
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return v.control(facts, b)
}
func (v *Viewer) control(kind byte, b []byte) error {
	if v.observe {
		return ErrOwnership
	}
	return v.client.send(context.Background(), v.channel, kind, b, func() error {
		v.mu.Lock()
		defer v.mu.Unlock()
		if v.err != nil {
			return ErrClosed
		}
		return nil
	})
}

type Keyboard struct {
	mu                                sync.Mutex
	viewer                            *Viewer
	generation                        uint64
	rendered                          bool
	cols, rows, cellWidth, cellHeight int
}
type Input struct {
	keyboard   *Keyboard
	viewer     *Viewer
	generation uint64
}

func (k *Keyboard) Select(v *Viewer) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.generation++
	k.viewer = v
	k.rendered = false
}

type Owner struct {
	viewer     *Viewer
	generation uint64
}

func (k *Keyboard) Rendered(owner Owner, cols, rows, cellWidth, cellHeight int) bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.viewer != owner.viewer || k.generation != owner.generation || owner.viewer == nil || owner.viewer.remote || !owner.viewer.alive() {
		return false
	}
	if cols < 1 || rows < 1 || cellWidth < 1 || cellHeight < 1 {
		if k.rendered {
			k.generation++
		}
		k.rendered = false
		return false
	}
	if k.cols != cols || k.rows != rows || k.cellWidth != cellWidth || k.cellHeight != cellHeight {
		k.generation++
		k.cols, k.rows, k.cellWidth, k.cellHeight = cols, rows, cellWidth, cellHeight
	}
	k.rendered = true
	return true
}

func (k *Keyboard) Deselect(v *Viewer) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.viewer == v {
		k.generation++
		k.viewer = nil
		k.rendered = false
	}
}

func (k *Keyboard) Invalidate(v *Viewer) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.viewer == v {
		k.generation++
		k.rendered = false
	}
}
func (k *Keyboard) Capture() (Input, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if !k.rendered || k.viewer == nil || k.viewer.observe || k.viewer.remote || !k.viewer.alive() {
		return Input{}, false
	}
	return Input{k, k.viewer, k.generation}, true
}

func (k *Keyboard) CaptureFor(v *Viewer) (Input, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.viewer != v || !k.rendered || v == nil || v.observe || v.remote || !v.alive() {
		return Input{}, false
	}
	return Input{k, v, k.generation}, true
}

func (k *Keyboard) OwnerKey() Owner {
	k.mu.Lock()
	defer k.mu.Unlock()
	return Owner{k.viewer, k.generation}
}

func (k *Keyboard) OwnerFor(v *Viewer) Owner {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.viewer != v {
		return Owner{}
	}
	return Owner{k.viewer, k.generation}
}

func (i Input) Valid() bool {
	if i.keyboard == nil {
		return false
	}
	k := i.keyboard
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.viewer == i.viewer && k.generation == i.generation && k.rendered && !i.viewer.remote && i.viewer.alive()
}
func (i Input) Write(b []byte) (int, error) {
	if i.keyboard == nil {
		return 0, ErrOwnership
	}
	if err := i.viewer.InputError(); err != nil {
		return 0, err
	}
	if len(b) > MaxInputBytes {
		return 0, ErrBusy
	}
	if len(b) == 0 {
		return 0, nil
	}
	err := i.viewer.client.send(context.Background(), i.viewer.channel, data, b, func() error {
		k := i.keyboard
		k.mu.Lock()
		defer k.mu.Unlock()
		i.viewer.mu.Lock()
		defer i.viewer.mu.Unlock()
		if k.viewer != i.viewer || k.generation != i.generation || !k.rendered || i.viewer.remote || i.viewer.err != nil {
			return ErrOwnership
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return len(b), nil
}

var _ io.Reader = (*Stream)(nil)
var _ io.Writer = Input{}
