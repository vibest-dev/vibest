package core

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
)

func Optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (t Terminal) Activity() string {
	if t.Status == nil || t.Status.State == "" {
		return "unknown"
	}
	return t.Status.State
}

func (t Terminal) NeedsCloseConfirmation() bool { return t.State != "finished" }

func (c *Client) Run(ctx context.Context, o TerminalRunParams) (Terminal, error) {
	var r RunResult
	err := c.Call(ctx, "terminal.run", o, &r)
	if err == nil && r.Address == "" {
		err = errors.New("core: run omitted terminal identity")
	}
	return r.Terminal, err
}
func (c *Client) Terminal(ctx context.Context, address string) (Terminal, error) {
	var t Terminal
	err := c.Call(ctx, "terminal.get", TerminalGetParams{Terminal: address}, &t)
	return t, err
}
func (c *Client) Kill(ctx context.Context, address string) error {
	return c.Call(ctx, "terminal.kill", TerminalKillParams{Terminal: address}, nil)
}

func (c *Client) Machines(ctx context.Context) ([]MachineView, error) {
	var r MachineListResult
	err := c.Call(ctx, "machine.list", MachineListParams{}, &r)
	return r.Machines, err
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
	Snapshot SubscribeResult
	reader   *bufio.Reader
}

func (c *Client) Subscribe(ctx context.Context) (*Subscription, error) {
	var snap SubscribeResult
	s, err := c.call(ctx, "events.subscribe", EventsSubscribeParams{}, &snap, true)
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
