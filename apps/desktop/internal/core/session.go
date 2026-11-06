package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"time"
)

type Document struct {
	Value   json.RawMessage `json:"value"`
	Version uint64          `json:"version"`
}
type SessionState struct {
	Layout    Layout
	Version   uint64
	Terminals map[string]Terminal
	Machines  []Machine
	Programs  map[string]uint64
	DocEpoch  uint64
	Connected bool
	Error     string
}

type Session struct {
	client   *Client
	sub      *Subscription
	mu       sync.Mutex
	edits    sync.Mutex
	state    SessionState
	seq      uint64
	programs map[string]uint64
	viewers  map[string]*Viewer
	changes  chan struct{}
	done     chan struct{}
}

func OpenSession(ctx context.Context, c *Client) (*Session, error) {
	sub, err := c.Subscribe(ctx)
	if err != nil {
		return nil, err
	}
	s := &Session{client: c, sub: sub, seq: sub.Snapshot.Seq, programs: map[string]uint64{}, viewers: map[string]*Viewer{}, changes: make(chan struct{}, 1), done: make(chan struct{})}
	s.state.Terminals = map[string]Terminal{}
	for _, t := range sub.Snapshot.Terminals {
		s.state.Terminals[t.Address] = t
	}
	if err = s.refresh(ctx); err != nil {
		sub.Close()
		return nil, err
	}
	s.state.Connected = true
	go s.watch()
	go s.pollMachines()
	return s, nil
}

var MachinePoll = 5 * time.Second

func (s *Session) pollMachines() {
	t := time.NewTicker(MachinePoll)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
		}
		ctx, cancel := context.WithTimeout(context.Background(), MachinePoll)
		machines, err := s.client.Machines(ctx)
		cancel()
		if err != nil {
			continue
		}
		s.mu.Lock()
		changed := !reflect.DeepEqual(s.state.Machines, machines)
		s.state.Machines = machines
		s.mu.Unlock()
		if changed {
			s.signal()
		}
	}
}
func (s *Session) Changes() <-chan struct{} { return s.changes }
func (s *Session) Done() <-chan struct{}    { return s.done }
func (s *Session) Close() error             { return s.client.Close() }
func (s *Session) signal() {
	select {
	case s.changes <- struct{}{}:
	default:
	}
}
func (s *Session) State() SessionState {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.state
	state.Programs = s.programs
	b, _ := json.Marshal(state)
	var snapshot SessionState
	json.Unmarshal(b, &snapshot)
	return snapshot
}
func (s *Session) load(ctx context.Context) (Layout, uint64, error) {
	var d Document
	if err := s.client.Call(ctx, "doc.get", map[string]string{"name": LayoutDocument}, &d); err != nil {
		return Layout{}, 0, err
	}
	l := Layout{Schema: LayoutSchema, CoreID: s.client.hello.Core.ID}
	if len(d.Value) > 0 && string(d.Value) != "null" {
		l = Layout{}
		if err := json.Unmarshal(d.Value, &l); err != nil {
			return Layout{}, 0, fmt.Errorf("layout: invalid document: %w", err)
		}
	}
	if err := l.Validate(s.client.hello.Core.ID); err != nil {
		return Layout{}, 0, err
	}
	return l, d.Version, nil
}
func (s *Session) refresh(ctx context.Context) error {
	l, version, err := s.load(ctx)
	if err != nil {
		return err
	}
	machines, err := s.client.Machines(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if version >= s.state.Version {
		s.state.Layout = l
		s.state.Version = version
	}
	s.state.Machines = machines
	s.revalidateViewers()
	s.signal()
	return nil
}
func (s *Session) revalidateViewers() {
	for pane, v := range s.viewers {
		p := s.state.Layout.Pane(pane)
		if p == nil || p.Terminal != v.ref || s.validRef(p.Terminal) != nil {
			v.Close()
			delete(s.viewers, pane)
		}
	}
}
func (s *Session) validRef(ref TerminalRef) error {
	_, terminal, remote := strings.Cut(ref.Address, "/")
	if ref.Address == "" || (remote && (terminal == "" || strings.Contains(terminal, "/") || strings.Contains(ref.CoreID, "/"))) {
		return errors.New("core: invalid terminal reference")
	}
	id := s.client.hello.Core.ID
	if remote {
		id = ""
		for _, m := range s.state.Machines {
			if m.ID == ref.CoreID && m.State == "connected" {
				id = m.ID
				break
			}
		}
	}
	if id == "" || id != ref.CoreID {
		return errors.New("core: terminal's owning machine identity is unavailable or changed")
	}
	return nil
}

func (s *Session) Ref(address string) (TerminalRef, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.state.Connected {
		return TerminalRef{}, ErrClosed
	}
	id := s.client.hello.Core.ID
	if machine, rest, remote := strings.Cut(address, "/"); remote {
		if strings.Contains(rest, "/") {
			return TerminalRef{}, errors.New("core: nested remote addresses are not yet supported")
		}
		id = ""
		for _, m := range s.state.Machines {
			if (m.Name == machine || m.ID == machine) && m.State == "connected" {
				id = m.ID
				break
			}
		}
	}
	if id == "" || address == "" {
		return TerminalRef{}, errors.New("core: unknown terminal owner")
	}
	return TerminalRef{CoreID: id, Address: address}, nil
}

func (s *Session) Edit(ctx context.Context, change func(*Layout) error) error {
	s.edits.Lock()
	defer s.edits.Unlock()
	before := s.State()
	if !before.Connected {
		return ErrClosed
	}
	next := before.Layout
	if err := change(&next); err != nil {
		return err
	}
	if err := next.Validate(s.client.hello.Core.ID); err != nil {
		return err
	}
	b, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if len(b) > 1<<20 {
		return errors.New("layout: document exceeds Core's 1 MiB limit")
	}
	var result struct {
		Version uint64 `json:"version"`
	}
	err = s.client.Call(ctx, "doc.set", map[string]any{"name": LayoutDocument, "value": next, "version": before.Version}, &result)
	if err != nil {
		var rpc *RPCError
		if errors.As(err, &rpc) && rpc.Data.Kind == "conflict" {
			if refreshErr := s.refresh(ctx); refreshErr != nil {
				return fmt.Errorf("%w; refreshing winner: %v", err, refreshErr)
			}
		}
		if ctx.Err() != nil {
			s.client.Close()
		}
		return err
	}
	if result.Version <= before.Version {
		s.client.Close()
		return errors.New("core: document version did not advance")
	}
	s.mu.Lock()
	if result.Version >= s.state.Version {
		s.state.Layout = next
		s.state.Version = result.Version
		s.revalidateViewers()
	}
	s.mu.Unlock()
	s.signal()
	return nil
}

func (s *Session) Attach(ctx context.Context, pane string, o AttachOptions) (*Viewer, error) {
	s.mu.Lock()
	p := s.state.Layout.Pane(pane)
	if !s.state.Connected || p == nil {
		s.mu.Unlock()
		return nil, ErrClosed
	}
	ref := p.Terminal
	if err := s.validRef(ref); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	incarnation := s.programs[ref.Address]
	if v := s.viewers[pane]; v != nil {
		v.Close()
		delete(s.viewers, pane)
	}
	s.mu.Unlock()
	o.Terminal = ref.wireAddress()
	v, err := s.client.Attach(ctx, o)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p = s.state.Layout.Pane(pane)
	if !s.state.Connected || p == nil || p.Terminal != ref || s.programs[ref.Address] != incarnation || s.validRef(ref) != nil || !ref.matchesAddress(v.Terminal.Address) {
		v.Close()
		return nil, ErrOwnership
	}
	if old := s.viewers[pane]; old != nil {
		v.Close()
		return nil, ErrOwnership
	}
	v.ref = ref
	if strings.Contains(ref.Address, "/") {
		v.remote = true
	}
	s.viewers[pane] = v
	return v, nil
}
func (s *Session) invalidateProgram(address string) {
	s.programs[address]++
	for pane, v := range s.viewers {
		if v.Terminal.Address == address || v.ref.Address == address {
			v.Close()
			delete(s.viewers, pane)
		}
	}
}
func (s *Session) watch() {
	defer close(s.done)
	for {
		e, err := s.sub.Next()
		if err == nil {
			err = s.apply(e)
		}
		if err != nil {
			s.client.Close()
			s.mu.Lock()
			s.state.Connected = false
			s.state.Error = err.Error()
			for _, v := range s.viewers {
				v.Close()
			}
			s.viewers = map[string]*Viewer{}
			s.mu.Unlock()
			s.signal()
			return
		}
	}
}
func (s *Session) apply(e Event) error {
	s.mu.Lock()
	switch e.Method {
	case "missed":
		for address := range s.state.Terminals {
			s.invalidateProgram(address)
		}
		s.state.Terminals = map[string]Terminal{}
		for _, t := range e.Params.Terminals {
			s.state.Terminals[t.Address] = t
		}
		s.seq = e.Params.Seq
		s.state.DocEpoch++
		s.mu.Unlock()
		return s.refresh(context.Background())
	case "heartbeat":
		if e.Params.Seq > s.seq {
			s.mu.Unlock()
			return errors.New("core: event gap; reconnect required")
		}
		s.mu.Unlock()
		return nil
	case "event":
		if e.Params.Seq <= s.seq {
			s.mu.Unlock()
			return nil
		}
		if e.Params.Seq != s.seq+1 {
			s.mu.Unlock()
			return errors.New("core: event gap; reconnect required")
		}
		s.seq = e.Params.Seq
	default:
		s.mu.Unlock()
		return nil
	}
	address := e.Params.Terminal
	if e.Params.Type == "doc" {
		s.mu.Unlock()
		var d struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(e.Params.Data, &d); err != nil {
			return err
		}
		if d.Name == LayoutDocument && e.Params.Machine == "" {
			return s.refresh(context.Background())
		}
		if e.Params.Machine == "" {
			s.mu.Lock()
			s.state.DocEpoch++
			s.mu.Unlock()
			s.signal()
		}
		return nil
	}
	var err error
	switch e.Params.Type {
	case "created", "restarted":
		s.invalidateProgram(address)
		var t Terminal
		err = json.Unmarshal(e.Params.Data, &t)
		if err == nil {
			if t.Address != address || address == "" {
				err = errors.New("core: invalid terminal event identity")
			} else {
				s.state.Terminals[address] = t
			}
		}
	case "removed":
		s.invalidateProgram(address)
		delete(s.state.Terminals, address)
	default:
		t, known := s.state.Terminals[address]
		if known {
			if e.Params.Type == "lost" || e.Params.Type == "finished" {
				s.invalidateProgram(address)
				t.PID = nil
				t.Foreground = nil
				if e.Params.Type == "finished" {
					t.State = "finished"
				}
			}
			if e.Params.Type == "foreground" {
				err = json.Unmarshal(e.Params.Data, &t.Foreground)
			} else if e.Params.Type != "turn" {
				switch e.Params.Type {
				case "labels":
					t.Labels = nil
				case "status":
					t.Status, t.Records = nil, nil
				}
				err = json.Unmarshal(e.Params.Data, &t)
			} else {
				var turn struct {
					Turn uint64 `json:"turn"`
				}
				err = json.Unmarshal(e.Params.Data, &turn)
				t.Turn = turn.Turn
			}
			s.state.Terminals[address] = t
		}
	}
	s.mu.Unlock()
	s.signal()
	return err
}

func (ref TerminalRef) wireAddress() string {
	if _, terminal, remote := strings.Cut(ref.Address, "/"); remote {
		return ref.CoreID + "/" + terminal
	}
	return ref.Address
}
func (ref TerminalRef) matchesAddress(address string) bool {
	_, want, remote := strings.Cut(ref.Address, "/")
	if !remote {
		return address == ref.Address
	}
	prefix, got, returnedRemote := strings.Cut(address, "/")
	return returnedRemote && prefix != "" && got == want
}

func (s *Session) Kill(ctx context.Context, ref TerminalRef) error {
	s.mu.Lock()
	err := s.validRef(ref)
	if !s.state.Connected {
		err = ErrClosed
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return s.client.Kill(ctx, ref.wireAddress())
}

func (s *Session) Run(ctx context.Context, o RunOptions) (Terminal, TerminalRef, error) {
	s.mu.Lock()
	id := s.client.hello.Core.ID
	remote := o.On != "" && o.On != id
	if remote {
		id = ""
		for _, m := range s.state.Machines {
			if m.ID == o.On && m.State == "connected" {
				id = m.ID
				break
			}
		}
	}
	connected := s.state.Connected
	s.mu.Unlock()
	if !connected {
		return Terminal{}, TerminalRef{}, ErrClosed
	}
	if id == "" {
		return Terminal{}, TerminalRef{}, errors.New("core: terminal owner unavailable")
	}
	if remote {
		o.On = id
	} else {
		o.On = ""
	}
	record, err := s.client.Run(ctx, o)
	ref := TerminalRef{CoreID: id, Address: record.Address}
	if err == nil {
		_, terminal, routed := strings.Cut(record.Address, "/")
		if routed != remote || (routed && (terminal == "" || strings.Contains(terminal, "/"))) {
			err = errors.New("core: run returned invalid terminal address")
		}
	}
	return record, ref, err
}
