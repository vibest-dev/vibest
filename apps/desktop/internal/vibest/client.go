package vibest

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
)

const Protocol = 5

const (
	ackMethod       = "@effect/rpc/Ack"
	interruptMethod = "@effect/rpc/Interrupt"
	maxLine         = 16 << 20
)

var ErrClosed = errors.New("vibest: connection closed")

func SocketPath() string {
	home := os.Getenv("VIBEST_HOME")
	if home == "" {
		user, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		home = filepath.Join(user, ".vibest")
	}
	return filepath.Join(home, "vibest.sock")
}

type Error struct {
	Tag     string
	Message string
	Raw     json.RawMessage
}

func (e *Error) Error() string {
	if e.Message != "" {
		return "vibest: " + e.Message
	}
	return "vibest: " + e.Tag
}

type Mismatch struct {
	Protocol int    `json:"protocol"`
	Version  string `json:"version"`
	Message  string `json:"message"`
	Action   string `json:"action"`
}

func (e *Error) Mismatch() (Mismatch, bool) {
	var body struct {
		Mismatch *Mismatch `json:"mismatch"`
	}
	if e.Tag != "ProtocolRejected" || json.Unmarshal(e.Raw, &body) != nil || body.Mismatch == nil {
		return Mismatch{}, false
	}
	return *body.Mismatch, true
}

type wireError struct {
	Message string `json:"message"`
	Data    []struct {
		Tag   string          `json:"_tag"`
		Error json.RawMessage `json:"error"`
	} `json:"data"`
}

func (w wireError) decode() *Error {
	for _, d := range w.Data {
		if d.Tag != "Fail" || len(d.Error) == 0 {
			continue
		}
		var body struct {
			Tag      string `json:"_tag"`
			Message  string `json:"message"`
			Mismatch *struct {
				Message string `json:"message"`
			} `json:"mismatch"`
		}
		_ = json.Unmarshal(d.Error, &body)
		message := body.Message
		if message == "" && body.Mismatch != nil {
			message = body.Mismatch.Message
		}
		return &Error{Tag: body.Tag, Message: message, Raw: d.Error}
	}
	return &Error{Tag: "Cause", Message: w.Message}
}

type inbound struct {
	ID     *uint64         `json:"id"`
	Method string          `json:"method"`
	Chunk  bool            `json:"chunk"`
	Result json.RawMessage `json:"result"`
	Error  *wireError      `json:"error"`
}

type request struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      uint64      `json:"id"`
	Method  string      `json:"method"`
	Params  any         `json:"params"`
	Headers [][2]string `json:"headers"`
}

type control struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  struct {
		RequestID uint64 `json:"requestId"`
	} `json:"params"`
}

type reply struct {
	result json.RawMessage
	err    error
}

type Client struct {
	conn    net.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  uint64
	calls   map[uint64]chan reply
	streams map[uint64]*Stream
	err     error
	done    chan struct{}
}

func Dial(ctx context.Context, path string) (*Client, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", path)
	if err != nil {
		return nil, err
	}
	c := &Client{conn: conn, calls: map[uint64]chan reply{}, streams: map[uint64]*Stream{}, done: make(chan struct{})}
	go c.read()
	return c, nil
}

func (c *Client) Close() error {
	err := c.conn.Close()
	<-c.done
	return err
}

func (c *Client) Done() <-chan struct{} { return c.done }

func headers(method, repository string) [][2]string {
	if method == "Ping" {
		return [][2]string{}
	}
	return [][2]string{{"vibest-protocol", fmt.Sprint(Protocol)}, {"vibest-caller", "cli"}, {"vibest-repository", repository}}
}

func (c *Client) write(v any) error {
	line, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.conn.Write(append(line, '\n'))
	return err
}

func (c *Client) send(method, repository string, params any, register func(id uint64)) (uint64, error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return 0, c.err
	}
	c.nextID++
	id := c.nextID
	register(id)
	c.mu.Unlock()
	return id, c.write(request{JSONRPC: "2.0", ID: id, Method: method, Params: params, Headers: headers(method, repository)})
}

func (c *Client) Call(ctx context.Context, method, repository string, params, out any) error {
	ch := make(chan reply, 1)
	id, err := c.send(method, repository, params, func(id uint64) { c.calls[id] = ch })
	if err != nil {
		c.forget(id)
		return err
	}
	select {
	case r := <-ch:
		if r.err != nil {
			return r.err
		}
		if out == nil {
			return nil
		}
		return json.Unmarshal(r.result, out)
	case <-ctx.Done():
		c.forget(id)
		_ = c.control(interruptMethod, id)
		return ctx.Err()
	}
}

func (c *Client) forget(id uint64) {
	c.mu.Lock()
	delete(c.calls, id)
	delete(c.streams, id)
	c.mu.Unlock()
}

func (c *Client) control(method string, id uint64) error {
	m := control{JSONRPC: "2.0", Method: method}
	m.Params.RequestID = id
	return c.write(m)
}

type Stream struct {
	client *Client
	id     uint64
	chunks chan []json.RawMessage
	end    chan error
	once   sync.Once
}

func (c *Client) Stream(method, repository string, params any) (*Stream, error) {
	s := &Stream{client: c, chunks: make(chan []json.RawMessage, 1), end: make(chan error, 1)}
	id, err := c.send(method, repository, params, func(id uint64) { c.streams[id] = s })
	s.id = id
	if err != nil {
		c.forget(id)
		return nil, err
	}
	return s, nil
}

func (s *Stream) Next(ctx context.Context) ([]json.RawMessage, error) {
	select {
	case chunk := <-s.chunks:
		if err := s.client.control(ackMethod, s.id); err != nil {
			return nil, err
		}
		return chunk, nil
	case err := <-s.end:
		s.end <- err
		return nil, err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Stream) Close() error {
	var err error
	s.once.Do(func() {
		s.client.forget(s.id)
		err = s.client.control(interruptMethod, s.id)
	})
	return err
}

var ErrStreamEnded = errors.New("vibest: stream ended")

func (c *Client) read() {
	defer close(c.done)
	scanner := bufio.NewScanner(c.conn)
	scanner.Buffer(make([]byte, 64<<10), maxLine)
	for scanner.Scan() {
		var m inbound
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil || m.ID == nil || m.Method != "" {
			continue
		}
		c.deliver(*m.ID, m)
	}
	err := scanner.Err()
	if err == nil {
		err = ErrClosed
	}
	c.mu.Lock()
	c.err = err
	calls, streams := c.calls, c.streams
	c.calls, c.streams = map[uint64]chan reply{}, map[uint64]*Stream{}
	c.mu.Unlock()
	for _, ch := range calls {
		ch <- reply{err: err}
	}
	for _, s := range streams {
		s.end <- err
	}
}

func (c *Client) deliver(id uint64, m inbound) {
	c.mu.Lock()
	ch, isCall := c.calls[id]
	s, isStream := c.streams[id]
	if !m.Chunk {
		delete(c.calls, id)
		delete(c.streams, id)
	}
	c.mu.Unlock()
	var err error
	if m.Error != nil {
		err = m.Error.decode()
	}
	switch {
	case isCall:
		ch <- reply{result: m.Result, err: err}
	case isStream && m.Chunk:
		var values []json.RawMessage
		if json.Unmarshal(m.Result, &values) != nil {
			values = nil
		}
		s.chunks <- values
	case isStream:
		if err == nil {
			err = ErrStreamEnded
		}
		s.end <- err
	}
}
