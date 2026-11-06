package app

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"vibest-desktop/internal/core"
)

type coreAppFrame struct {
	channel uint32
	body    []byte
}
type coreAppControl struct {
	channel uint32
	kind    byte
	body    []byte
}
type coreAppFixture struct {
	mu         sync.Mutex
	write      sync.Mutex
	events     sync.Mutex
	peer       net.Conn
	reconnect  chan net.Conn
	methods    []string
	params     []json.RawMessage
	machines   []core.Machine
	layout     core.Layout
	version    uint64
	seq        uint64
	terminals  map[string]core.Terminal
	inputs     chan coreAppFrame
	controls   []coreAppControl
	channels   map[string]uint32
	outputs    uint64
	failOnce   map[string]string
	hold       map[string]<-chan struct{}
	held       chan string
	wrap       func(net.Conn) net.Conn
	runResult  *core.Terminal
	attachData map[string]string
	exec       func(string, []string) ([]byte, error)
	execResult any
	otherDocs  []string
	vibest     string
}

func (f *coreAppFixture) send(ch uint32, p []byte) {
	f.write.Lock()
	defer f.write.Unlock()
	b := make([]byte, 9+len(p))
	binary.LittleEndian.PutUint32(b, ch)
	binary.LittleEndian.PutUint32(b[5:], uint32(len(p)))
	copy(b[9:], p)
	f.peer.Write(b)
}
func (f *coreAppFixture) json(ch uint32, v any) { b, _ := json.Marshal(v); f.send(ch, b) }
func (f *coreAppFixture) serve() {
	defer f.peer.Close()
	r := bufio.NewReader(f.peer)
	if _, err := r.ReadBytes('\n'); err != nil {
		return
	}
	h := map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"version": "0.1.13", "generation": 1, "framed": true, "core": map[string]string{"id": "app-fixture"}, "methods": []string{"terminal.run", "terminal.get", "terminal.attach", "terminal.kill", "events.subscribe", "doc.get", "doc.set", "machine.list", "machine.exec"}, "features": []string{"framed", "attach", "events", "status", "shell"}}}
	hello, _ := json.Marshal(h)
	f.peer.Write(append(hello, '\n'))
	channel := uint32(1)
	for {
		var head [9]byte
		if _, err := io.ReadFull(r, head[:]); err != nil {
			return
		}
		ch := binary.LittleEndian.Uint32(head[:])
		kind := head[4]
		p := make([]byte, binary.LittleEndian.Uint32(head[5:]))
		if _, err := io.ReadFull(r, p); err != nil {
			return
		}
		if ch != 0 {
			if kind == 0 {
				f.inputs <- coreAppFrame{ch, p}
			} else {
				f.mu.Lock()
				f.controls = append(f.controls, coreAppControl{ch, kind, p})
				f.mu.Unlock()
			}
			continue
		}
		var req struct {
			ID     uint64
			Method string
			Params json.RawMessage
		}
		if json.Unmarshal(p, &req) != nil {
			return
		}
		f.mu.Lock()
		f.methods = append(f.methods, req.Method)
		f.params = append(f.params, req.Params)
		if kind := f.failOnce[req.Method]; kind != "" {
			delete(f.failOnce, req.Method)
			f.mu.Unlock()
			f.json(0, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": "fixture refusal", "data": map[string]any{"kind": kind}}})
			continue
		}
		var result any = map[string]any{}
		var created *core.Terminal
		var attach bool
		gateKey := req.Method
		switch req.Method {
		case "events.subscribe":
			records := []core.Terminal{}
			for _, record := range f.terminals {
				records = append(records, record)
			}
			result = map[string]any{"channel": 1, "seq": f.seq, "terminals": records}
		case "doc.get":
			var args struct{ Name string }
			json.Unmarshal(req.Params, &args)
			if args.Name != core.LayoutDocument {
				result = map[string]any{"value": nil, "version": 0}
				break
			}
			result = map[string]any{"value": f.layout, "version": f.version}
		case "machine.exec":
			if f.execResult != nil {
				result = f.execResult
				break
			}
			var args struct {
				CWD      string
				Argv     []string
				On, Line string
				Timeout  float64
			}
			json.Unmarshal(req.Params, &args)
			code := 0
			var out []byte
			var e error
			if args.On != "" || args.Line != "" || args.Timeout != 5 {
				e = fmt.Errorf("unsafe exec request")
			} else if f.exec == nil {
				e = fmt.Errorf("no fake Git collaborator")
			} else {
				out, e = f.exec(args.CWD, args.Argv)
			}
			stderr := ""
			if e != nil {
				code = 1
				stderr = e.Error()
			}
			result = map[string]any{"code": code, "stdout": base64.StdEncoding.EncodeToString(out), "stderr": base64.StdEncoding.EncodeToString([]byte(stderr)), "truncated": false, "timed_out": false}
		case "machine.list":
			result = map[string]any{"machines": f.machines}
		case "terminal.run":
			if f.runResult != nil {
				result = *f.runResult
				break
			}
			address := fmt.Sprintf("t%d", len(f.terminals)+1)
			t := core.Terminal{Address: address, State: "live", Cols: 80, Rows: 24, CWD: "/inert/workspace"}
			f.terminals[address] = t
			result = t
			created = &t
		case "terminal.attach":
			var args core.AttachOptions
			json.Unmarshal(req.Params, &args)
			gateKey += " " + args.Terminal
			channel++
			if f.channels == nil {
				f.channels = map[string]uint32{}
			}
			f.channels[args.Terminal] = channel
			result = map[string]any{"channel": channel, "terminal": f.terminals[args.Terminal]}
			attach = true
		case "terminal.kill":
		case "doc.set":
			var args struct {
				Name    string
				Value   json.RawMessage
				Version uint64
			}
			json.Unmarshal(req.Params, &args)
			if args.Name != core.LayoutDocument {
				f.otherDocs = append(f.otherDocs, args.Name)
				result = map[string]any{"version": 1}
				break
			}
			if args.Name != core.LayoutDocument || args.Version != f.version {
				f.mu.Unlock()
				return
			}
			json.Unmarshal(args.Value, &f.layout)
			f.version++
			result = map[string]any{"version": f.version}
		default:
			f.mu.Unlock()
			return
		}
		gate := f.hold[gateKey]
		delete(f.hold, gateKey)
		held := f.held
		f.mu.Unlock()
		targetChannel := channel
		respond := func() {
			if gate != nil {
				held <- gateKey
				<-gate
			}
			f.mu.Lock()
			failure := f.failOnce[gateKey]
			delete(f.failOnce, gateKey)
			f.mu.Unlock()
			if failure != "" {
				f.json(0, map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": "fixture refusal", "data": map[string]any{"kind": failure}}})
				return
			}
			f.json(0, map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
			if created != nil {
				f.mu.Lock()
				eventGate := f.hold["event.created"]
				delete(f.hold, "event.created")
				f.mu.Unlock()
				if eventGate != nil {
					record := *created
					go func() { held <- "event.created"; <-eventGate; f.report("created", record) }()
				} else {
					f.report("created", *created)
				}
			}
			if attach {
				data := "\x1b[?9001lCore fixture ready\r\n"
				f.mu.Lock()
				if value, ok := f.attachData[gateKey]; ok {
					data = value
				}
				f.mu.Unlock()
				f.send(targetChannel, []byte(data))
			}
		}
		if gate != nil {
			go respond()
		} else {
			respond()
		}
	}
}

func (f *coreAppFixture) report(kind string, record core.Terminal) {
	f.events.Lock()
	defer f.events.Unlock()
	f.mu.Lock()
	if kind == "removed" {
		delete(f.terminals, record.Address)
	} else {
		f.terminals[record.Address] = record
	}
	f.seq++
	seq := f.seq
	f.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"seq": seq, "type": kind, "terminal": record.Address, "data": record}})
	f.send(1, append(b, '\n'))
}
func newCoreAppFixture(t *testing.T) (*App, *coreAppFixture) { return newCoreAppFixtureWith(t, nil) }
func newCoreAppFixtureWith(t *testing.T, prepare func(*coreAppFixture)) (*App, *coreAppFixture) {
	t.Helper()
	left, right := net.Pipe()
	f := &coreAppFixture{peer: right, layout: core.Layout{Schema: 1, CoreID: "app-fixture"}, seq: 1, terminals: map[string]core.Terminal{}, inputs: make(chan coreAppFrame, 32)}
	if prepare != nil {
		prepare(f)
	}
	go f.serve()
	a := NewApp("/inert/never-dialed.sock")
	a.vibestSocket = f.vibest
	f.reconnect = make(chan net.Conn, 1)
	if f.wrap != nil {
		f.reconnect <- f.wrap(left)
	} else {
		f.reconnect <- left
	}
	a.dialCore = func(ctx context.Context, _ string) (*core.Client, error) {
		select {
		case conn := <-f.reconnect:
			return core.Connect(ctx, conn)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		left.Close()
		right.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("App.Run did not stop")
		}
	})
	awaitCoreApp(t, a, func() bool { return a.coreSession != nil && a.coreState.Connected })
	return a, f
}
func awaitCoreApp(t *testing.T, a *App, condition func() bool) {
	t.Helper()
	until := time.Now().Add(3 * time.Second)
	for {
		a.mu.Lock()
		ok := condition()
		a.mu.Unlock()
		if ok {
			return
		}
		if time.Now().After(until) {
			a.mu.Lock()
			detail := fmt.Sprintf("connected=%v pending=%v error=%q note=%q state=%+v", a.coreState.Connected, a.corePending, a.err, a.navigationNote, a.coreState)
			a.mu.Unlock()
			t.Fatal("Core App state did not converge: " + detail)
		}
		time.Sleep(time.Millisecond)
	}
}
func coreAppAct(a *App, action func()) { a.mu.Lock(); defer a.mu.Unlock(); action() }
func TestCoreAppCreatesAndNavigatesWithoutLegacyControl(t *testing.T) {
	a, f := newCoreAppFixture(t)
	f.mu.Lock()
	for _, m := range f.methods {
		if m == "terminal.run" {
			t.Fatal("startup implicitly created a terminal")
		}
	}
	f.mu.Unlock()
	coreAppAct(a, a.NewWorkspace)
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces) == 1 && !a.corePending })
	a.mu.Lock()
	workspace, first := a.coreSelection.Workspace, a.coreSelection.Pane
	a.NewTab(workspace)
	a.mu.Unlock()
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces[0].Tabs) == 2 && !a.corePending })
	a.mu.Lock()
	secondTab := a.coreSelection.Tab
	a.ShowPane(first)
	if a.coreSelection.Pane != first {
		t.Fatal("local pane navigation failed")
	}
	a.SelectTab(secondTab)
	if a.coreSelection.Tab != secondTab {
		t.Fatal("local tab navigation failed")
	}
	a.RenameTab(secondTab, "renamed")
	a.mu.Unlock()
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Tab(secondTab).Label == "renamed" })
	a.mu.Lock()
	for _, field := range []string{"Boot", "Revision", "AgentCompletions"} {
		if _, exists := reflect.TypeOf(*a.snap).FieldByName(field); exists {
			t.Fatal("presentation regained legacy freshness state", field)
		}
	}
	if _, description := a.activity(activityScope{tab: secondTab}); description != "Activity unknown" {
		t.Fatal(description)
	}
	a.mu.Unlock()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.methods {
		if strings.HasPrefix(m, "workspace.") || strings.HasPrefix(m, "pane.") || strings.HasPrefix(m, "tab.") {
			t.Fatal("legacy RPC", m)
		}
	}
}
func TestCoreAppCloseNeedsConfirmationAndStaysBoundToSession(t *testing.T) {
	a, f := newCoreAppFixture(t)
	coreAppAct(a, a.NewWorkspace)
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces) == 1 && !a.corePending })
	a.mu.Lock()
	a.ClosePane(a.coreSelection.Pane)
	d := a.dialog
	if d == nil || !d.safe {
		t.Fatal("unknown activity skipped conservative confirmation")
	}
	a.coreSession = nil
	d.run("")
	a.mu.Unlock()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.methods {
		if m == "terminal.kill" {
			t.Fatal("close retargeted a changed session")
		}
	}
}

func TestCoreAppReorderResizeMoveAndConfirmedClose(t *testing.T) {
	a, _ := newCoreAppFixture(t)
	coreAppAct(a, a.NewWorkspace)
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces) == 1 && !a.corePending })
	a.mu.Lock()
	ws := a.coreSelection.Workspace
	firstTab := a.coreSelection.Tab
	a.NewTab(ws)
	a.mu.Unlock()
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces[0].Tabs) == 2 && !a.corePending })
	coreAppAct(a, func() { a.NewTab(ws) })
	awaitCoreApp(t, a, func() bool { return len(a.coreState.Layout.Workspaces[0].Tabs) == 3 && !a.corePending })
	coreAppAct(a, func() { a.MoveTab(firstTab, 2) })
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Workspaces[0].Tabs[1].ID == firstTab })
	a.mu.Lock()
	pane, tab := a.coreSelection.Pane, a.coreSelection.Tab
	a.Split(pane, "down")
	a.mu.Unlock()
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Tab(tab).Root.Pane == nil && !a.corePending })
	coreAppAct(a, func() { a.coreSetRatio(tab, nil, .65) })
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Tab(tab).Root.Ratio > .64 })
	a.mu.Lock()
	moving := a.coreSelection.Pane
	ref := a.coreState.Layout.Pane(moving).Terminal
	a.MovePaneNewWorkspace(moving)
	a.mu.Unlock()
	awaitCoreApp(t, a, func() bool {
		return len(a.coreState.Layout.Workspaces) == 2 && !a.corePending && a.coreSelection.Pane == moving
	})
	a.mu.Lock()
	if a.coreState.Layout.Pane(moving).Terminal != ref {
		t.Error("move rebound terminal")
	}
	a.ClosePane(moving)
	d := a.dialog
	a.dialog = nil
	if d == nil {
		a.mu.Unlock()
		t.Fatal("missing confirmation")
	}
	d.run("")
	a.mu.Unlock()
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane(moving) == nil && !a.corePending })
}
func TestCoreAppEmptyTargetsNeverFallBackToCreateOrCloseAll(t *testing.T) {
	a, f := newCoreAppFixture(t)
	coreAppAct(a, func() { a.Split("", "right"); a.Split("missing", "right"); a.CloseWorkspace(""); a.CloseTab("") })
	a.mu.Lock()
	pending := a.corePending
	a.mu.Unlock()
	if pending {
		t.Fatal("invalid target armed navigation")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.methods {
		if m == "terminal.run" || m == "terminal.kill" {
			t.Fatal("empty target fell back", m)
		}
	}
}

func TestCoreAppPinnedRemotePaneDoesNotBorrowAliasReplacementActivity(t *testing.T) {
	remote := core.NewPane(core.TerminalRef{CoreID: "remote-A", Address: "rohan/t1"})
	local := core.NewPane(core.TerminalRef{CoreID: "app-fixture", Address: "t2"})
	a, _ := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		f.layout.AddWorkspace("Remote", "/inert", "rohan", remote)
		f.layout.AddWorkspace("Local", "/inert", "", local)
		f.machines = []core.Machine{{Name: "renamed", ID: "remote-A", State: "connected"}, {Name: "rohan", ID: "remote-B", State: "connected"}}
		f.terminals["rohan/t1"] = core.Terminal{Address: "rohan/t1", Reported: true, Status: &core.Status{State: "done"}, Title: "replacement B", Turn: 44}
		f.terminals["t2"] = core.Terminal{Address: "t2", Reported: true, Status: &core.Status{State: "working"}}
	})
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.coreState.Terminals["rohan/t1"].Reported {
		t.Fatal("raw Core catalog was discarded")
	}
	for _, m := range a.machines {
		if record, ok := m.coreRecords[remote.ID]; ok {
			if record.Reported || record.Activity() != "unknown" || record.Turn != 0 || record.Title != "" {
				t.Fatal("pinned A borrowed B's report", record)
			}
		}
	}
	if a.machines[0].coreRecords[local.ID].Activity() != "working" {
		t.Fatal("local activity changed")
	}
}

func publishCoreLayout(t *testing.T, a *App, f *coreAppFixture, change func(*coreAppFixture)) {
	t.Helper()
	f.events.Lock()
	f.mu.Lock()
	change(f)
	f.version++
	version := f.version
	f.seq++
	seq := f.seq
	f.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "event", "params": map[string]any{"seq": seq, "type": "doc", "data": map[string]string{"name": core.LayoutDocument}}})
	f.send(1, append(b, '\n'))
	f.events.Unlock()
	awaitCoreApp(t, a, func() bool { return a.coreState.Version == version })
}
