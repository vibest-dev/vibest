package core

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	maxPayload     = 16 << 20
	streamWindow   = 256 << 10
	maxQueued      = 1 << 20
	MaxInputBytes  = maxQueued - 9
	maxChannels    = 128
	data           = byte(0)
	credit         = byte(1)
	closeChannel   = byte(2)
	resize         = byte(3)
	focus          = byte(4)
	facts          = byte(5)
	automaticInput = byte(6)
)

var (
	ErrClosed      = errors.New("core: connection or attach closed")
	ErrBusy        = errors.New("core: bounded queue is full")
	ErrOwnership   = errors.New("core: input owner is no longer ready")
	ErrRemoteInput = errors.New("Remote input unsupported: Core0.1.13 relay reattachment has no ordered program-incarnation fence")
)

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Kind string `json:"kind"`
		Hint string `json:"hint"`
	} `json:"data"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("core: %s: %s", e.Data.Kind, e.Message) }

type Mismatch struct {
	Version    string
	Generation uint32
	Reason     string
	Missing    []string
}

func (e *Mismatch) CoreTooOld() bool {
	return e.Reason == "" && (len(e.Missing) > 0 || e.Generation < PinnedGeneration)
}

func (e *Mismatch) CoreTooNew() bool { return e.Reason == "" && e.Generation > PinnedGeneration }

func (e *Mismatch) Error() string {
	if len(e.Missing) > 0 {
		return fmt.Sprintf("herdr-core %s cannot do everything this app needs (%s)", e.Version, strings.Join(e.Missing, ", "))
	}
	if e.Reason != "" {
		return fmt.Sprintf("herdr-core refused protocol generation %d (%s); this app needs herdr-core %s", PinnedGeneration, e.Reason, PinnedVersion)
	}
	return fmt.Sprintf("herdr-core %s speaks protocol generation %d; this app needs generation %d (herdr-core %s)", e.Version, e.Generation, PinnedGeneration, PinnedVersion)
}

var requiredMethods = []string{"terminal.run", "terminal.get", "terminal.attach", "terminal.kill", "events.subscribe", "doc.get", "doc.set", "machine.list"}
var requiredFeatures = []string{"framed", "attach", "events", "status", "shell"}

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      uint64          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  any             `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

type response struct {
	result json.RawMessage
	stream *Stream
	err    error
}
type pending struct {
	ctx    context.Context
	stream bool
	reply  chan response
}
type outgoing struct {
	ctx   context.Context
	bytes []byte
	done  chan error
	admit func() error
}

type Client struct {
	conn        net.Conn
	hello       HelloResult
	mu          sync.Mutex
	next        uint64
	calls       map[uint64]*pending
	streams     map[uint32]*Stream
	early       map[uint32]*Stream
	earlyClosed map[uint32]*Stream
	used        map[uint32]bool
	queued      int
	out         chan outgoing
	creditWake  chan struct{}
	done        chan struct{}
	err         error
}

func Connect(ctx context.Context, conn net.Conn) (*Client, error) {
	return connect(ctx, conn, 5*time.Second)
}

func connect(ctx context.Context, conn net.Conn, helloWait time.Duration) (*Client, error) {
	ok := false
	defer func() {
		if !ok {
			conn.Close()
		}
	}()
	deadline := time.Now().Add(helloWait)
	if d, has := ctx.Deadline(); has && d.Before(deadline) {
		deadline = d
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	generation := uint32(PinnedGeneration)
	hello, _ := json.Marshal(message{JSONRPC: "2.0", ID: 1, Method: "hello", Params: HelloParams{Generation: &generation, Framed: true}})
	if err := writeAll(conn, append(hello, '\n')); err != nil {
		return nil, err
	}
	r := bufio.NewReaderSize(conn, 4096)
	line, err := readLine(r, 1<<20)
	if err != nil {
		return nil, fmt.Errorf("core hello: %w", err)
	}
	var reply message
	if err := json.Unmarshal(line, &reply); err != nil {
		return nil, err
	}
	if reply.JSONRPC != "2.0" || reply.ID != 1 {
		return nil, errors.New("core: invalid hello reply")
	}
	if reply.Error != nil {
		if reply.Error.Data.Kind == "unsupported_generation" {
			return nil, &Mismatch{Generation: PinnedGeneration, Reason: reply.Error.Message}
		}
		return nil, reply.Error
	}
	var h HelloResult
	if err := json.Unmarshal(reply.Result, &h); err != nil {
		return nil, err
	}
	if h.Generation != PinnedGeneration {
		return nil, &Mismatch{Version: h.Version, Generation: h.Generation}
	}
	if !h.Framed || h.Core.ID == "" {
		return nil, errors.New("core: hello did not switch to a framed connection with a core id")
	}
	var missing []string
	for _, m := range requiredMethods {
		if !slices.Contains(h.Methods, m) {
			missing = append(missing, m)
		}
	}
	for _, f := range requiredFeatures {
		if !slices.Contains(h.Features, f) {
			missing = append(missing, f)
		}
	}
	if len(missing) > 0 {
		return nil, &Mismatch{Version: h.Version, Generation: h.Generation, Missing: missing}
	}
	if !stop() || ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	c := &Client{conn: conn, hello: h, next: 1, calls: map[uint64]*pending{}, streams: map[uint32]*Stream{}, early: map[uint32]*Stream{}, earlyClosed: map[uint32]*Stream{}, used: map[uint32]bool{}, out: make(chan outgoing, maxChannels), creditWake: make(chan struct{}, 1), done: make(chan struct{})}
	ok = true
	go c.writeLoop()
	go c.readLoop(r)
	return c, nil
}

func (c *Client) Hello() HelloResult {
	h := c.hello
	h.Methods = slices.Clone(h.Methods)
	h.Features = slices.Clone(h.Features)
	return h
}
func (c *Client) Done() <-chan struct{} { return c.done }
func (c *Client) Err() error            { c.mu.Lock(); defer c.mu.Unlock(); return c.err }
func (c *Client) Close() error          { c.fail(ErrClosed); return nil }

func (c *Client) fail(err error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = err
	streams := c.streams
	for ch, s := range c.early {
		streams[ch] = s
	}
	for ch, s := range c.earlyClosed {
		streams[ch] = s
	}
	c.earlyClosed = map[uint32]*Stream{}
	c.early = map[uint32]*Stream{}
	c.streams = map[uint32]*Stream{}
	c.calls = map[uint64]*pending{}
	close(c.done)
	c.mu.Unlock()
	c.conn.Close()
	for _, s := range streams {
		s.end(err, nil)
	}
}

func (c *Client) Call(ctx context.Context, method string, params, result any) error {
	_, err := c.call(ctx, method, params, result, false)
	return err
}
func (c *Client) call(ctx context.Context, method string, params, result any, opens bool) (*Stream, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !slices.Contains(c.hello.Methods, method) {
		return nil, fmt.Errorf("core: method %s not advertised", method)
	}
	p := &pending{ctx: ctx, stream: opens, reply: make(chan response, 1)}
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return nil, err
	}
	reserved := len(c.used)
	if opens {
		unmatched := 0
		for _, call := range c.calls {
			if call.stream {
				unmatched++
			}
		}
		reserved += max(0, unmatched-len(c.early))
	}
	if len(c.calls) >= maxChannels || (opens && reserved >= maxChannels) {
		c.mu.Unlock()
		return nil, ErrBusy
	}
	c.next++
	id := c.next
	c.calls[id] = p
	c.mu.Unlock()
	b, err := json.Marshal(message{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	if err == nil {
		err = c.enqueue(outgoing{ctx: context.Background(), bytes: frame(0, data, b)})
	}
	if err != nil {
		c.mu.Lock()
		delete(c.calls, id)
		c.retireClosedEarly()
		c.mu.Unlock()
		return nil, err
	}
	select {
	case <-ctx.Done():
		go func() {
			select {
			case r := <-p.reply:
				if r.stream != nil {
					r.stream.Close()
				}
			case <-c.done:
			}
		}()
		return nil, ctx.Err()
	case <-c.done:
		return nil, c.Err()
	case r := <-p.reply:
		if r.err != nil {
			return nil, r.err
		}
		if result != nil {
			if err := json.Unmarshal(r.result, result); err != nil {
				if r.stream != nil {
					r.stream.Close()
				}
				return nil, err
			}
		}
		return r.stream, nil
	}
}

func (c *Client) enqueue(o outgoing) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return c.err
	}
	if len(o.bytes) > maxQueued || c.queued+len(o.bytes) > maxQueued {
		return ErrBusy
	}
	select {
	case c.out <- o:
		c.queued += len(o.bytes)
		return nil
	default:
		return ErrBusy
	}
}
func (c *Client) send(ctx context.Context, ch uint32, kind byte, p []byte, admit func() error) error {
	done := make(chan error, 1)
	if err := c.enqueue(outgoing{ctx: ctx, bytes: frame(ch, kind, p), done: done, admit: admit}); err != nil {
		return err
	}
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		return c.Err()
	}
}
func (c *Client) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case o := <-c.out:
			c.mu.Lock()
			c.queued -= len(o.bytes)
			c.mu.Unlock()
			err := o.ctx.Err()
			if err == nil && o.admit != nil {
				err = o.admit()
			}
			if err == nil {
				err = c.writeFrame(o.bytes)
			}
			if o.done != nil {
				o.done <- err
			}
		case <-c.creditWake:
		}
		for _, b := range c.takeCredits() {
			if c.writeFrame(b) != nil {
				return
			}
		}
	}
}
func (c *Client) writeFrame(b []byte) error {
	err := c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err == nil {
		err = writeAll(c.conn, b)
	}
	if err != nil {
		c.fail(err)
	}
	return err
}
func (c *Client) takeCredits() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	var batch [][]byte
	for ch, s := range c.streams {
		s.mu.Lock()
		if s.err == nil && s.creditDebt > 0 {
			var p [4]byte
			binary.LittleEndian.PutUint32(p[:], s.creditDebt)
			s.creditDebt = 0
			batch = append(batch, frame(ch, credit, p[:]))
		}
		s.mu.Unlock()
	}
	return batch
}
func (c *Client) readLoop(r io.Reader) {
	for {
		ch, kind, b, err := readFrame(r)
		if err != nil {
			c.fail(err)
			return
		}
		if ch == 0 {
			if kind != data {
				c.fail(errors.New("core: non-DATA control frame"))
				return
			}
			if err := c.reply(b); err != nil {
				c.fail(err)
				return
			}
			continue
		}
		c.mu.Lock()
		s, used := c.streams[ch], c.used[ch]
		isEarly := false
		if s == nil && !used {
			opens := 0
			for _, p := range c.calls {
				if p.stream {
					opens++
				}
			}
			if opens > 0 && (kind == closeChannel || len(c.early) < opens) && len(c.used) < maxChannels {
				s = &Stream{client: c, channel: ch, wake: make(chan struct{}, 1)}
				c.early[ch], c.used[ch] = s, true
			}
		}
		if early := c.early[ch]; early != nil {
			s, isEarly = early, true
		} else if closed := c.earlyClosed[ch]; closed != nil {
			s, isEarly = closed, true
		}
		c.mu.Unlock()
		if s == nil {
			if used {
				if kind == closeChannel {
					c.mu.Lock()
					delete(c.used, ch)
					c.mu.Unlock()
				}
				continue
			}
			c.fail(fmt.Errorf("core: unowned channel %d", ch))
			return
		}
		switch kind {
		case data:
			if !s.feed(b) {
				c.fail(errors.New("core: stream exceeded receive credit"))
				return
			}
		case closeChannel:
			s.end(io.EOF, b)
			c.mu.Lock()
			if isEarly {
				delete(c.early, ch)
				c.earlyClosed[ch] = s
			} else {
				delete(c.streams, ch)
				delete(c.used, ch)
			}
			c.mu.Unlock()
		default:
			c.fail(fmt.Errorf("core: invalid server stream kind %d", kind))
			return
		}
	}
}
func (c *Client) reply(b []byte) error {
	var m message
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	if m.JSONRPC != "2.0" || m.ID == 0 {
		return errors.New("core: invalid control reply")
	}
	c.mu.Lock()
	p := c.calls[m.ID]
	delete(c.calls, m.ID)
	if p == nil {
		c.mu.Unlock()
		return errors.New("core: unsolicited reply")
	}
	r := response{result: m.Result}
	if m.Error != nil {
		r.err = m.Error
	}
	if p.stream && r.err == nil {
		var v struct {
			Channel uint32 `json:"channel"`
		}
		if err := json.Unmarshal(m.Result, &v); err != nil {
			c.mu.Unlock()
			return err
		}
		early := c.early[v.Channel]
		if early == nil {
			early = c.earlyClosed[v.Channel]
		}
		if v.Channel == 0 || (c.used[v.Channel] && early == nil) || (early == nil && len(c.used) >= maxChannels) {
			c.mu.Unlock()
			return errors.New("core: invalid or excessive stream allocation")
		}
		s := early
		if s == nil {
			s = &Stream{client: c, channel: v.Channel, wake: make(chan struct{}, 1)}
		}
		delete(c.early, v.Channel)
		delete(c.earlyClosed, v.Channel)
		if s.alive() {
			c.streams[v.Channel], c.used[v.Channel] = s, true
		} else {
			delete(c.used, v.Channel)
		}
		r.stream = s
	}
	c.retireClosedEarly()
	c.mu.Unlock()
	p.reply <- r
	return nil
}

func (c *Client) retireClosedEarly() {
	for _, p := range c.calls {
		if p.stream {
			return
		}
	}
	for ch := range c.earlyClosed {
		delete(c.used, ch)
		delete(c.earlyClosed, ch)
	}
}

func frame(ch uint32, kind byte, p []byte) []byte {
	b := make([]byte, 9+len(p))
	binary.LittleEndian.PutUint32(b, ch)
	b[4] = kind
	binary.LittleEndian.PutUint32(b[5:], uint32(len(p)))
	copy(b[9:], p)
	return b
}
func readFrame(r io.Reader) (uint32, byte, []byte, error) {
	var h [9]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return 0, 0, nil, err
	}
	n := binary.LittleEndian.Uint32(h[5:])
	if n > maxPayload {
		return 0, 0, nil, errors.New("core: frame exceeds 16 MiB")
	}
	b := make([]byte, n)
	_, err := io.ReadFull(r, b)
	return binary.LittleEndian.Uint32(h[:]), h[4], b, err
}
func readLine(r *bufio.Reader, limit int) ([]byte, error) {
	var b []byte
	for {
		part, err := r.ReadSlice('\n')
		if len(b)+len(part) > limit {
			return nil, errors.New("core: JSON line too large")
		}
		b = append(b, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		return b, err
	}
}
func writeAll(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, err := w.Write(b)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}
