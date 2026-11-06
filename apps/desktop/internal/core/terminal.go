package core

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
)

type Status struct {
	State    string  `json:"state"`
	App      string  `json:"app"`
	Title    string  `json:"title"`
	Message  string  `json:"msg"`
	Kind     *string `json:"kind"`
	Progress *uint8  `json:"progress"`
}
type Foreground struct {
	PID  uint32   `json:"pid"`
	Name string   `json:"name"`
	Argv []string `json:"argv"`
	CWD  string   `json:"cwd"`
}
type Terminal struct {
	Address    string            `json:"address"`
	Name       *string           `json:"name"`
	Argv       []string          `json:"argv"`
	CWD        string            `json:"cwd"`
	State      string            `json:"state"`
	PID        *uint32           `json:"pid"`
	Reason     *string           `json:"reason"`
	ExitCode   *int              `json:"exit_code"`
	Signal     *int              `json:"signal"`
	Cols       uint16            `json:"cols"`
	Rows       uint16            `json:"rows"`
	Keep       bool              `json:"keep"`
	Reported   bool              `json:"reported"`
	Status     *Status           `json:"status"`
	Records    map[string]Status `json:"records"`
	Foreground *Foreground       `json:"foreground"`
	Title      string            `json:"title"`
	Turn       uint64            `json:"turn"`
	Labels     map[string]string `json:"labels"`
	Parent     *string           `json:"parent"`
}

func (t Terminal) Activity() string {
	if t.Status == nil || t.Status.State == "" {
		return "unknown"
	}
	return t.Status.State
}

func (t Terminal) NeedsCloseConfirmation() bool { return t.State != "finished" }

type RunOptions struct {
	CWD    string            `json:"cwd,omitempty"`
	On     string            `json:"on,omitempty"`
	Argv   []string          `json:"argv,omitempty"`
	Labels map[string]string `json:"labels,omitempty"`
	Keep   bool              `json:"keep,omitempty"`
}

func (c *Client) Run(ctx context.Context, o RunOptions) (Terminal, error) {
	var t Terminal
	err := c.Call(ctx, "terminal.run", o, &t)
	if err == nil && t.Address == "" {
		err = errors.New("core: run omitted terminal identity")
	}
	return t, err
}
func (c *Client) Terminal(ctx context.Context, address string) (Terminal, error) {
	var t Terminal
	err := c.Call(ctx, "terminal.get", map[string]string{"terminal": address}, &t)
	return t, err
}
func (c *Client) Kill(ctx context.Context, address string) error {
	return c.Call(ctx, "terminal.kill", map[string]string{"terminal": address}, nil)
}

type Machine struct {
	Name      string  `json:"name"`
	ID        string  `json:"id"`
	Host      string  `json:"host"`
	Target    string  `json:"target"`
	Session   *string `json:"session"`
	State     string  `json:"state"`
	Why       *string `json:"why"`
	Version   string  `json:"version"`
	Via       bool    `json:"via"`
	Temporary bool    `json:"temporary"`
}

func (c *Client) Machines(ctx context.Context) ([]Machine, error) {
	var r struct {
		Machines []Machine `json:"machines"`
	}
	err := c.Call(ctx, "machine.list", struct{}{}, &r)
	return r.Machines, err
}

type Snapshot struct {
	Seq       uint64     `json:"seq"`
	Terminals []Terminal `json:"terminals"`
}
type Event struct {
	Method string `json:"method"`
	Params struct {
		Seq       uint64          `json:"seq"`
		Type      string          `json:"type"`
		Terminal  string          `json:"terminal"`
		Machine   string          `json:"machine"`
		Data      json.RawMessage `json:"data"`
		Terminals []Terminal      `json:"terminals"`
	} `json:"params"`
}

type Subscription struct {
	*Stream
	Snapshot Snapshot
	reader   *bufio.Reader
}

func (c *Client) Subscribe(ctx context.Context) (*Subscription, error) {
	var snap Snapshot
	s, err := c.call(ctx, "events.subscribe", struct{}{}, &snap, true)
	if err != nil {
		return nil, err
	}
	return &Subscription{Stream: s, Snapshot: snap, reader: bufio.NewReader(s)}, nil
}
func (s *Subscription) Next() (Event, error) {
	var e Event
	b, err := readLine(s.reader, maxQueued)
	if err != nil {
		return e, err
	}
	var header struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
	}
	if err = json.Unmarshal(b, &header); err != nil {
		return e, err
	}
	if header.JSONRPC != "2.0" || len(header.ID) > 0 {
		return e, errors.New("core: invalid event notification")
	}
	err = json.Unmarshal(b, &e)
	return e, err
}
