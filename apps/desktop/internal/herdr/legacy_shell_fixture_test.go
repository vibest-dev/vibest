package herdr

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

func ClientSocketPath(session string) string {
	return filepath.Join(filepath.Dir(SocketPath(session)), "herdr-client.sock")
}

const (
	maxFrame    = 32 << 20
	helloKind   = "endpoint.hello.v1"
	welcomeKind = "endpoint.welcome.v1"
	snapKind    = "shell.snapshot.v1"
)

const (
	msgControl = 20

	msgResize     = 12
	msgPaneInput  = 13
	msgPopupInput = 14
	msgRequest    = 15
	msgHostTheme  = 17
	msgFocus      = 18

	msgShutdown     = 3
	msgNotify       = 4
	msgClipboard    = 5
	msgTitle        = 6
	msgBell         = 9
	msgSurface      = 13
	msgNotification = 14
	msgError        = 15
	msgResponse     = 18
)

type Shell struct {
	conn     net.Conn
	reader   *bufio.Reader
	wmu      sync.Mutex
	writeErr error
	Version  string

	completions *agentCompletions

	OnSnapshot func(*ShellSnapshot)
	OnSurface  func(*Surface)
	OnEvent    func(Event)

	mu       sync.Mutex
	snap     *ShellSnapshot
	surface  *Surface
	unshown  bool
	ready    chan struct{}
	active   chan struct{}
	activate sync.Once
	reqMu    sync.Mutex
	pending  string
	response chan []byte
	buf      []byte
	nextID   int
}

type ShellSnapshot struct {
	Boot               string            `json:"boot_id"`
	Revision           uint64            `json:"revision"`
	ConfigDiagnostic   string            `json:"config_diagnostic"`
	FocusedWorkspaceID string            `json:"focused_workspace_id"`
	FocusedTabID       string            `json:"focused_tab_id"`
	FocusedPaneID      string            `json:"focused_pane_id"`
	Workspaces         []ShellWorkspace  `json:"workspaces"`
	Tabs               []ShellTab        `json:"tabs"`
	Panes              []ShellPane       `json:"panes"`
	Agents             []ShellAgent      `json:"agents"`
	AgentCompletions   map[string]uint64 `json:"-"`
}

type ShellWorkspace struct {
	ID          string         `json:"workspace_id"`
	ActiveTabID string         `json:"active_tab_id"`
	Number      int            `json:"number"`
	Label       string         `json:"label"`
	Branch      string         `json:"branch"`
	AheadBehind []int          `json:"git_ahead_behind"`
	Focused     bool           `json:"focused"`
	AgentStatus string         `json:"agent_status"`
	Worktree    *ShellWorktree `json:"worktree"`
}

type ShellWorktree struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Linked bool   `json:"is_linked_worktree"`
}

type ShellTab struct {
	ID          string `json:"tab_id"`
	WorkspaceID string `json:"workspace_id"`
	Number      int    `json:"number"`
	Label       string `json:"label"`
	Zoomed      bool   `json:"zoomed"`
	Focused     bool   `json:"focused"`
	AgentStatus string `json:"agent_status"`
}

type ShellPane struct {
	ID    string `json:"pane_id"`
	TabID string `json:"tab_id"`
	Label string `json:"label"`
	Cwd   string `json:"cwd"`
}

type ShellAgent struct {
	PaneID      string `json:"pane_id"`
	WorkspaceID string `json:"workspace_id"`
	TabID       string `json:"tab_id"`
	Name        string `json:"name"`
	Display     string `json:"display_agent"`
	Agent       string `json:"agent"`
	Title       string `json:"terminal_title_stripped"`
	AgentStatus string `json:"agent_status"`
	Focused     bool   `json:"focused"`
}

type Event struct {
	Kind                       EventKind
	Title, Body                string
	WorkspaceID, TabID, PaneID string
}

type EventKind int

const (
	EventToast EventKind = iota
	EventNotification
	EventError
	EventClipboard
	EventTitle
	EventBell
)

type Hello struct {
	Cols, Rows            int
	CellWidth, CellHeight int
}

func DialShell(ctx context.Context, path string, h Hello) (*Shell, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", path)
	if err != nil {
		return nil, err
	}
	return handshake(ctx, conn, h, 4*time.Second)
}

func handshake(ctx context.Context, conn net.Conn, h Hello, wait time.Duration) (*Shell, error) {
	s := &Shell{conn: conn, ready: make(chan struct{}), active: make(chan struct{}), response: make(chan []byte, 1)}
	hello, _ := json.Marshal(map[string]any{
		"generation":    1,
		"cell_width_px": h.CellWidth, "cell_height_px": h.CellHeight,
		"surface_size":         map[string]int{"cols": h.Cols, "rows": h.Rows},
		"pixel_mouse":          false,
		"direct_graphics":      false,
		"endpoint_keybindings": false,
		"mouse_capture":        false,
		"surface_active":       false,
		"surface_scroll":       true,
		"surface_delta":        true,
		"snapshot_codecs":      []string{"shell.snapshot.v1"},
		"surface_codecs":       []string{"shell.surface.v1"},
		"input_codecs":         []string{"shell.input.semantic.v1"},
		"blob_codecs":          []string{"shell.blob.v1"},
	})
	if err := s.control(helloKind, string(hello)); err != nil {
		conn.Close()
		return nil, err
	}
	conn.SetReadDeadline(time.Now().Add(wait))
	r := bufio.NewReader(conn)
	msg, err := readFrame(r)
	if err != nil {
		conn.Close()
		if errors.Is(err, io.EOF) {
			return nil, errors.New("herdr closed the connection: is it older than 0.9?")
		}
		return nil, err
	}
	conn.SetReadDeadline(time.Time{})
	d0 := &dec{b: msg}
	if d0.uint() != msgControl || d0.str() != welcomeKind {
		conn.Close()
		return nil, errors.New("herdr: no welcome")
	}
	var w struct {
		Generation    int    `json:"generation"`
		ServerVersion string `json:"server_version"`
		Error         *struct{ Code, Message string }
	}
	if err := json.Unmarshal([]byte(d0.str()), &w); err != nil {
		conn.Close()
		return nil, err
	}
	if w.Error != nil {
		conn.Close()
		return nil, fmt.Errorf("herdr %s refused this client: %s", w.ServerVersion, w.Error.Message)
	}
	if w.Generation != 1 {
		conn.Close()
		return nil, fmt.Errorf("herdr %s speaks endpoint generation %d; this app needs generation 1", w.ServerVersion, w.Generation)
	}
	s.Version = w.ServerVersion
	go func() { <-ctx.Done(); conn.Close() }()
	s.reader = r
	return s, nil
}

func readFrame(r *bufio.Reader) ([]byte, error) {
	var n [4]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(n[:])
	if size == 0 || size > maxFrame {
		return nil, errors.New("herdr: bad frame size")
	}
	b := make([]byte, size)
	_, err := io.ReadFull(r, b)
	return b, err
}

var ErrInputInvalidated = errors.New("herdr: input ownership changed")

func (s *Shell) send(e *enc) error { return s.sendIf(e, nil) }

func (s *Shell) sendIf(e *enc, allowed func() bool) error {
	frame := binary.LittleEndian.AppendUint32(nil, uint32(len(e.b)))
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if s.writeErr != nil {
		return s.writeErr
	}
	if allowed != nil && !allowed() {
		return ErrInputInvalidated
	}
	if err := s.conn.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
		s.writeErr = err
		return err
	}
	packet := append(frame, e.b...)
	n, err := s.conn.Write(packet)
	if err == nil && n != len(packet) {
		err = io.ErrShortWrite
	}
	s.writeErr = err
	return err
}

func (s *Shell) control(kind, data string) error {
	e := &enc{}
	e.uint(msgControl)
	e.str(kind)
	e.str(data)
	return s.send(e)
}

func (s *Shell) Close() error { return s.conn.Close() }

func (s *Shell) Run() error {
	defer close(s.response)
	for {
		msg, err := readFrame(s.reader)
		if err != nil {
			return err
		}
		if err := s.handle(msg); err != nil {
			s.conn.Close()
			return err
		}
	}
}

func (s *Shell) handle(msg []byte) error {
	d := &dec{b: msg}
	switch d.uint() {
	case msgControl:
		kind, data := d.str(), d.str()
		if kind == completionsKind {
			if d.err != nil {
				s.completions = nil
				return d.err
			}
			err := s.takeCompletions(data)
			if err != nil {
				s.completions = nil
			}
			return err
		}
		if kind == scrollKind || kind == deltaKind {
			if err := s.update(kind, data); err != nil {
				return err
			}
			break
		}
		if kind != snapKind {
			return nil
		}
		completions := s.completions
		s.completions = nil
		var snap ShellSnapshot
		if err := json.Unmarshal([]byte(data), &snap); err != nil {
			return err
		}
		if snap.Boot == "" {
			return errors.New("herdr: snapshot omitted boot identity")
		}
		if completions != nil && completions.boot == snap.Boot && completions.revision == snap.Revision {
			snap.AgentCompletions = completions.tokens
		}
		s.mu.Lock()
		first := s.snap == nil
		s.snap = &snap
		s.mu.Unlock()
		if first {
			close(s.ready)
		}
		s.OnSnapshot(&snap)
	case msgSurface:
		next := d.surface()
		if d.err != nil {
			return d.err
		}
		if next.Boot == "" {
			return errors.New("herdr: surface omitted boot identity")
		}
		if len(next.Frame.Cells) != next.Frame.W*next.Frame.H {
			return errors.New("herdr: bad surface")
		}
		s.mu.Lock()
		s.surface, s.unshown = next, true
		s.mu.Unlock()
	case msgPatch:
		p := d.patch()
		if d.err != nil {
			return d.err
		}
		s.mu.Lock()
		ok := s.surface != nil && s.surface.apply(p)
		s.unshown = s.unshown || ok
		s.mu.Unlock()
		if !ok {
			return errors.New("herdr: patch of another surface")
		}
	case msgResponse:
		d.str()
		id, final, data := d.str(), d.boolean(), d.bytes()
		s.mu.Lock()
		if id == s.pending {
			s.buf = append(s.buf, data...)
			if final {
				s.pending = ""
				s.response <- s.buf
				s.buf = nil
			}
		}
		s.mu.Unlock()
	case msgShutdown:
		reason := d.optStr()
		if reason == "" {
			reason = "server shut down"
		}
		return errors.New("herdr: " + reason)
	case msgNotify:
		d.uint()
		title, body := d.str(), d.optStr()
		s.OnEvent(Event{Kind: EventToast, Title: title, Body: body})
	case msgClipboard:
		if text, err := base64.StdEncoding.DecodeString(d.str()); err == nil {
			s.OnEvent(Event{Kind: EventClipboard, Body: string(text)})
		}
	case msgTitle:
		s.OnEvent(Event{Kind: EventTitle, Title: d.optStr()})
	case msgBell:
		s.OnEvent(Event{Kind: EventBell})
	case msgNotification:
		d.uint()
		ev := Event{Kind: EventNotification, Title: d.str(), Body: d.optStr()}
		if d.some() {
			d.uint()
		}
		d.optStr()
		ev.WorkspaceID, ev.TabID, ev.PaneID = d.optStr(), d.optStr(), d.optStr()
		s.OnEvent(ev)
	case msgError:
		s.OnEvent(Event{Kind: EventError, Title: d.str()})
	}
	s.publish()
	return nil
}

func (s *Shell) update(kind, data string) error {
	b, err := base64.RawStdEncoding.DecodeString(data)
	if err != nil {
		return err
	}
	apply := (*Surface).delta
	if kind == scrollKind {
		apply = (*Surface).scroll
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.surface == nil {
		return errors.New("herdr: " + kind + " without a surface")
	}
	next, err := apply(s.surface, b)
	if err != nil {
		return err
	}
	s.surface, s.unshown = next, true
	return nil
}

func (s *Shell) publish() {
	s.mu.Lock()
	sf := s.surface
	show := s.unshown && s.snap != nil && s.snap.Boot != "" && sf.Boot == s.snap.Boot && sf.Projection == s.snap.Revision
	if show {
		s.unshown, sf = false, sf.clone()
	}
	s.mu.Unlock()
	if show {
		s.OnSurface(sf)
	}
}

func (sf *Surface) clone() *Surface {
	c := *sf
	c.Frame.Cells = append([]Cell(nil), sf.Frame.Cells...)
	c.Panes = append([]SurfacePane(nil), sf.Panes...)
	return &c
}

type Error struct{ Code, Message string }

func (e *Error) Error() string { return e.Code + ": " + e.Message }

type response struct {
	Result json.RawMessage `json:"result"`
	Error  *Error          `json:"error"`
}

func (s *Shell) Call(ctx context.Context, method string, params, out any) error {
	select {
	case <-s.active:
	case <-ctx.Done():
		return ctx.Err()
	}
	return s.request(ctx, method, params, out)
}

func (s *Shell) request(ctx context.Context, method string, params, out any) error {
	select {
	case <-s.ready:
	case <-ctx.Done():
		return ctx.Err()
	}
	s.reqMu.Lock()
	defer s.reqMu.Unlock()
	if params == nil {
		params = struct{}{}
	}
	s.mu.Lock()
	s.nextID++
	id := "mygo-" + strconv.Itoa(s.nextID)
	boot := s.snap.Boot
	s.pending, s.buf = id, nil
	s.mu.Unlock()
	req, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	e := &enc{}
	e.uint(msgRequest)
	e.str(boot)
	e.str(string(req))
	if err := s.send(e); err != nil {
		return err
	}
	var data []byte
	select {
	case b, ok := <-s.response:
		if !ok {
			return errors.New("herdr: connection closed")
		}
		data = b
	case <-ctx.Done():
		s.conn.Close()
		return ctx.Err()
	}
	var res response
	if err := json.Unmarshal(data, &res); err != nil {
		return fmt.Errorf("herdr: bad response: %w", err)
	}
	if res.Error != nil {
		return res.Error
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(res.Result, out)
}

func (s *Shell) Activate(ctx context.Context) error {
	err := s.request(ctx, "client_shell.surface.set", map[string]bool{"active": true}, nil)
	if err == nil {
		s.activate.Do(func() { close(s.active) })
	}
	return err
}

func (s *Shell) Deactivate(ctx context.Context) error {
	return s.request(ctx, "client_shell.surface.set", map[string]bool{"active": false}, nil)
}

func (s *Shell) Resize(h Hello) error {
	e := &enc{}
	e.uint(msgResize)
	e.uint(uint64(h.CellWidth))
	e.uint(uint64(h.CellHeight))
	e.uint(uint64(h.Cols))
	e.uint(uint64(h.Rows))
	e.boolean(false)
	return s.send(e)
}

func (s *Shell) Focus(focused bool) error {
	e := &enc{}
	e.uint(msgFocus)
	e.boolean(focused)
	return s.send(e)
}

func (s *Shell) Theme(fg, bg RGB, palette []RGB) error {
	color := func(e *enc, c RGB) { e.u8(c.R); e.u8(c.G); e.u8(c.B) }
	for i, c := range []RGB{fg, bg} {
		e := &enc{}
		e.uint(msgHostTheme)
		e.uint(0)
		e.uint(uint64(i))
		color(e, c)
		if err := s.send(e); err != nil {
			return err
		}
	}
	e := &enc{}
	e.uint(msgHostTheme)
	e.uint(1)
	e.uint(uint64(len(palette)))
	for i, c := range palette {
		e.u8(uint8(i))
		color(e, c)
	}
	return s.send(e)
}

func (s *Shell) Input(t Target, events ...InputEvent) error { return s.input(t, nil, events...) }

func (s *Shell) InputOwned(t Target, boot string, valid func() bool, events ...InputEvent) error {
	return s.input(t, func() bool {
		if valid == nil || !valid() {
			return false
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		return boot != "" && s.snap != nil && s.snap.Boot == boot
	}, events...)
}

func (s *Shell) input(t Target, allowed func() bool, events ...InputEvent) error {
	e := &enc{}
	if t.Popup {
		e.uint(msgPopupInput)
	} else {
		e.uint(msgPaneInput)
	}
	e.str(t.ID)
	e.uint(uint64(len(events)))
	for _, ev := range events {
		ev.encode(e)
	}
	return s.sendIf(e, allowed)
}

func (s *ShellSnapshot) Agent(paneID string) *ShellAgent {
	for i := range s.Agents {
		if s.Agents[i].PaneID == paneID {
			return &s.Agents[i]
		}
	}
	return nil
}

func (s *ShellSnapshot) HasPane(id string) bool {
	for _, p := range s.Panes {
		if p.ID == id {
			return true
		}
	}
	return false
}

func (s *ShellSnapshot) TabsOf(workspaceID string) []ShellTab {
	var tabs []ShellTab
	for _, t := range s.Tabs {
		if t.WorkspaceID == workspaceID {
			tabs = append(tabs, t)
		}
	}
	return tabs
}
