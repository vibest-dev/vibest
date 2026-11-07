package app

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"time"
	"vibest-desktop/internal/presentation"

	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/coreview"
)

type coreWindow struct {
	coreClient        *core.Client
	coreSession       *core.Session
	coreSource        *core.Session
	coreClosing       []string
	coreState         core.SessionState
	coreSelection     core.Selection
	coreKeyboard      core.Keyboard
	coreViews         map[string]*coreview.Terminal
	coreAttached      map[string]core.TerminalRef
	coreLoading       map[string]bool
	coreErrors        map[string]string
	coreSelected      *coreview.Terminal
	coreBounds        map[string]ui.Rect
	coreNavigation    uint64
	corePending       bool
	coreCapture       *coreCapture
	coreFence         *coreCapture
	coreBlocked       bool
	coreOperationNote string
	coreFocusedFrame  bool
	coreEditorClick   string
	coreRetry         chan struct{}
	coreMismatch      *core.Mismatch
	coreMissing       bool
	coreFocusWake     chan struct{}
	coreNotices       chan coreNotice
	dialCore          func(context.Context, string) (*core.Client, error)
	gitExec           gitCommand
	editor            editorOpen
	projectWindow
}
type coreNotice struct {
	session *core.Session
	text    string
}

func newCoreWindow() coreWindow {
	return coreWindow{coreAttached: map[string]core.TerminalRef{}, coreBounds: map[string]ui.Rect{}, coreViews: map[string]*coreview.Terminal{}, coreLoading: map[string]bool{}, coreErrors: map[string]string{}, coreRetry: make(chan struct{}, 1), coreFocusWake: make(chan struct{}, 1), coreNotices: make(chan coreNotice, 8), dialCore: core.Dial, projectWindow: newProjectWindow()}
}

func (a *App) Run(ctx context.Context) {
	go a.vibestRun(ctx)
	backoff := 250 * time.Millisecond
	for ctx.Err() == nil {
		a.mu.Lock()
		a.coreMismatch, a.coreMissing = nil, false
		a.mu.Unlock()
		attempt, cancel := context.WithTimeout(ctx, 20*time.Second)
		c, err := a.dialCore(attempt, a.socket)
		var s *core.Session
		if err == nil {
			s, err = core.OpenSession(attempt, c)
		}
		cancel()
		if err != nil {
			if c != nil {
				c.Close()
			}
			var mismatch *core.Mismatch
			missing := errors.Is(err, core.ErrNoCore)
			if errors.As(err, &mismatch) || missing {
				a.mu.Lock()
				a.coreMismatch, a.coreMissing = mismatch, missing
				a.mu.Unlock()
				a.fail(err)
				select {
				case <-ctx.Done():
					return
				case <-a.coreRetry:
				}
				continue
			}
			a.fail(err)
		} else {
			a.mu.Lock()
			a.coreClient, a.coreSession = c, s
			a.coreNavigation++
			a.corePending = false
			a.version = c.Hello().Version
			a.coreApply(s)
			a.mu.Unlock()
			a.invalidate()
			focusDone := make(chan struct{})
			go func() { defer close(focusDone); a.coreFocusLoop(ctx, s) }()
			backoff = 250 * time.Millisecond
			active := true
			for active {
				select {
				case <-ctx.Done():
					active = false
				case <-a.coreRetry:
					active = false
				case <-s.Done():
					active = false
				case <-s.Changes():
					a.mu.Lock()
					changed := a.coreApply(s)
					a.mu.Unlock()
					if changed {
						a.invalidate()
					}
				case note := <-a.coreNotices:
					a.mu.Lock()
					if note.session == s {
						a.navigationNote = note.text
					}
					a.mu.Unlock()
					a.invalidate()
				}
			}
			a.mu.Lock()
			a.cancelCoreCapture()
			a.coreSelect(nil)
			a.coreState.Connected = false
			a.coreChrome()
			a.coreClient, a.coreSession = nil, nil
			a.err = s.State().Error
			views := a.coreViews
			a.coreViews = map[string]*coreview.Terminal{}
			clear(a.coreAttached)
			clear(a.coreLoading)
			clear(a.coreErrors)
			a.checkTabDrag()
			a.mu.Unlock()
			s.Close()
			<-focusDone
			for _, v := range views {
				v.Close()
			}
			a.invalidate()
		}
		select {
		case <-ctx.Done():
			return
		case <-a.coreRetry:
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 5*time.Second)
	}
}

func (a *App) coreApply(s *core.Session) bool {
	if a.coreSession != s {
		return false
	}
	state := s.State()
	freshSource := a.coreSource != s
	a.coreSource = s
	for id := range a.coreErrors {
		before, after := a.coreState.Layout.Pane(id), state.Layout.Pane(id)
		if freshSource || before == nil || after == nil || before.Terminal != after.Terminal || a.coreState.Programs[before.Terminal.Address] != state.Programs[after.Terminal.Address] {
			delete(a.coreErrors, id)
		}
	}
	for _, m := range a.machines {
		for ref := range m.coreSeen {
			_, exists := state.Terminals[ref.Address]
			if freshSource || !exists || a.coreState.Programs[ref.Address] != state.Programs[ref.Address] {
				delete(m.coreSeen, ref)
			}
		}
	}
	previous := a.coreState
	a.coreState = state
	a.connected = state.Connected
	a.err = state.Error
	a.coreSelection.Reconcile(&a.coreState.Layout)
	for id, v := range a.coreViews {
		p := state.Layout.Pane(id)
		if freshSource || p == nil || p.Terminal != a.coreAttached[id] || previous.Programs[p.Terminal.Address] != state.Programs[p.Terminal.Address] {
			if a.coreSelected == v {
				a.coreSelect(nil)
			}
			if freshSource || p == nil || p.Terminal != a.coreAttached[id] {
				delete(a.rightToPane, id)
			}
			delete(a.coreViews, id)
			delete(a.coreAttached, id)
			go v.Close()
		}
	}
	if n := a.coreCapture; n != nil && !a.validCoreCapture(n) {
		a.cancelCoreCapture()
	}
	a.coreChrome()
	a.coreFocus()
	a.checkTabDrag()
	return freshSource || !reflect.DeepEqual(previous, state)
}

func (a *App) coreChrome() {
	sel := a.coreSelection
	previous := map[string]*machine{}
	for _, m := range a.machines {
		previous[m.id()] = m
	}
	local := previous[""]
	if local == nil {
		local = newMachine(nil)
	}
	groups := map[string]*machine{"": local}
	local.connected = a.coreState.Connected
	local.err = a.coreState.Error
	if a.coreClient != nil {
		local.version = a.coreClient.Hello().Version
	}
	machines := []*machine{local}
	for _, record := range a.coreState.Machines {
		if record.Name == "" {
			continue
		}
		m := previous[record.Name]
		if m == nil {
			m = newMachine(&presentation.Machine{ID: record.Name})
		}
		groups[record.Name] = m
		m.remote.Label = record.Name
		m.connected = a.coreState.Connected && record.State == "connected"
		m.err = ""
		m.version = record.Version
		if record.State != "connected" {
			m.err = record.State
		}
		if record.Why != nil {
			m.err = *record.Why
		}
		machines = append(machines, m)
	}
	for _, w := range a.coreState.Layout.Workspaces {
		if groups[w.Machine] == nil {
			m := newMachine(&presentation.Machine{ID: w.Machine, Label: w.Machine})
			m.err = "Machine unavailable in Core catalog"
			groups[w.Machine] = m
			machines = append(machines, m)
		}
	}
	for _, m := range machines {
		m.snap = &presentation.Snapshot{FocusedWorkspaceID: sel.Workspace, FocusedTabID: sel.Tab, FocusedPaneID: sel.Pane}
		m.coreRecords = map[string]core.Terminal{}
		m.coreRefs = map[string]core.TerminalRef{}
		if m.coreSeen == nil {
			m.coreSeen = map[core.TerminalRef]uint64{}
		}
	}
	selected := local
	for wi, w := range a.coreState.Layout.Workspaces {
		m := groups[w.Machine]
		snap := m.snap
		if w.ID == sel.Workspace {
			selected = m
			m.coreWorkspace = w.ID
		}
		active := ""
		if len(w.Tabs) > 0 {
			active = w.Tabs[0].ID
		}
		if w.ID == sel.Workspace {
			active = sel.Tab
		}
		ws := presentation.Workspace{ID: w.ID, Label: w.Label, Number: wi + 1, Focused: w.ID == sel.Workspace, ActiveTabID: active, AgentStatus: "unknown", Branch: w.Branch, AheadBehind: slices.Clone(w.AheadBehind)}
		if w.Repository != "" {
			ws.Worktree = &presentation.Repository{Key: w.Repository, Linked: w.Linked}
		}
		snap.Workspaces = append(snap.Workspaces, ws)
		for ti, t := range w.Tabs {
			snap.Tabs = append(snap.Tabs, presentation.Tab{ID: t.ID, WorkspaceID: w.ID, Label: t.Label, Number: ti + 1, Focused: t.ID == sel.Tab, Zoomed: t.ID == sel.Tab && sel.Zoom != "", AgentStatus: "unknown"})
			walkCorePanes(t.Root, func(p *core.Pane) {
				record := a.coreState.Terminals[p.Terminal.Address]
				if strings.Contains(p.Terminal.Address, "/") {
					record = core.Terminal{Address: p.Terminal.Address}
				}
				name := p.Label
				if name == "" {
					name = record.Title
				}
				if name == "" {
					name = p.Terminal.Address
				}
				snap.Panes = append(snap.Panes, presentation.Pane{ID: p.ID, TabID: t.ID, Label: name, Cwd: record.CWD})
				m.coreRecords[p.ID] = record
				m.coreRefs[p.ID] = p.Terminal
				if record.Reported && record.Turn < m.coreSeen[p.Terminal] {
					delete(m.coreSeen, p.Terminal)
				}
				if record.Reported && record.Status != nil {
					snap.Agents = append(snap.Agents, presentation.Agent{PaneID: p.ID, WorkspaceID: w.ID, TabID: t.ID, Display: record.Status.App, Title: record.Status.Title, AgentStatus: record.Activity(), Focused: p.ID == sel.Pane})
				}
			})
		}
	}
	a.machines, a.machine = machines, selected
}

func walkCorePanes(n *core.Split, f func(*core.Pane)) {
	if n == nil {
		return
	}
	if n.Pane != nil {
		f(n.Pane)
		return
	}
	walkCorePanes(n.First, f)
	walkCorePanes(n.Second, f)
}

func (a *App) coreSelect(v *coreview.Terminal) {
	if a.coreSelected == v {
		return
	}
	if old := a.coreSelected; old != nil {
		old.Cancel()
	}
	a.coreSelected = v
	if v != nil {
		v.Select()
	}
	poke(a.coreFocusWake)
}
func (a *App) coreFocus() {
	tab := a.coreState.Layout.Tab(a.coreSelection.Tab)
	for id, view := range a.coreViews {
		shown := false
		if a.snap != nil && !a.windowClosed && tab != nil {
			walkCorePanes(tab.Root, func(p *core.Pane) {
				if p.ID == id && (a.coreSelection.Zoom == "" || a.coreSelection.Zoom == id) {
					shown = true
				}
			})
		}
		view.SetVisible(shown)
	}
	var v *coreview.Terminal
	if !a.corePending && !a.coreBlocked && a.connected && a.windowFocused && !a.windowClosed && a.dialog == nil && a.nativeDialog == nil {
		if n := a.coreCapture; n == nil || !n.awaitProgram {
			v = a.coreViews[a.coreSelection.Pane]
		}
	}
	a.coreSelect(v)
}
func (a *App) coreNavigate(change func(*core.Selection, *core.Layout) error) bool {
	a.cancelCoreCapture()
	a.coreNavigation++
	if !a.coreState.Connected || a.coreSession == nil || a.windowClosed {
		a.corePending = true
		a.coreSelect(nil)
		a.navigationNote = "Navigation paused: not connected to Core"
		a.invalidate()
		return false
	}
	if err := change(&a.coreSelection, &a.coreState.Layout); err != nil {
		a.corePending = true
		a.coreSelect(nil)
		a.navigationNote = "Navigation paused: " + err.Error()
		a.invalidate()
		return false
	}
	if strings.HasPrefix(a.navigationNote, "Navigation paused:") || a.navigationNote == "Creating terminal; input paused" || a.navigationNote == "Moving pane; input paused" {
		a.navigationNote = ""
	}
	a.corePending = false
	a.beginCoreCapture(a.coreSelection.Pane, false)
	a.coreChrome()
	a.coreFocus()
	a.returnFocus = a.dialog == nil && a.nativeDialog == nil
	a.checkTabDrag()
	a.invalidate()
	return true
}
func (a *App) coreNote(s *core.Session, text string) {
	select {
	case a.coreNotices <- coreNotice{s, text}:
	default:
	}
	a.invalidate()
}

func (a *App) coreEdit(change func(*core.Layout) error) {
	s := a.coreSession
	if s == nil {
		a.err = "Not connected to Core"
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.Edit(ctx, change); err != nil {
			a.coreNote(s, err.Error())
		}
	}()
}

func (a *App) coreCreate(workspace, pane, direction string) {
	if pane != "" && (a.coreBlocked || a.corePending || a.coreCapture != nil && (a.coreCapture.meaningful || a.coreCapture.composing || a.coreCapture.pending != nil)) {
		a.cancelNavigation()
		return
	}
	s := a.coreSession
	if s == nil {
		a.err = "Not connected to Core"
		return
	}
	if pane != "" {
		if a.coreState.Layout.Pane(pane) == nil {
			a.err = "Pane not found"
			return
		}
		switch direction {
		case "left", "right", "up", "down":
		default:
			a.err = "Invalid split direction"
			return
		}
	}
	if workspace != "" {
		found := false
		for _, w := range a.coreState.Layout.Workspaces {
			found = found || w.ID == workspace
		}
		if !found {
			a.err = "Workspace not found"
			return
		}
	}
	cwd, on := "", ""
	group := a.machine.id()
	if pane != "" {
		workspace, _ = a.coreState.Layout.Location(pane)
	}
	for _, w := range a.coreState.Layout.Workspaces {
		if w.ID == workspace {
			cwd, group = w.CWD, w.Machine
			if group != "" && pane == "" {
				mixed := false
				for _, tab := range w.Tabs {
					walkCorePanes(tab.Root, func(p *core.Pane) {
						if on == "" {
							on = p.Terminal.CoreID
						} else if on != p.Terminal.CoreID {
							mixed = true
						}
					})
				}
				if mixed {
					a.navigationNote = "Workspace has mixed terminal owners; split a specific pane instead"
					return
				}
			}
		}
	}
	if pane != "" {
		on = a.coreState.Layout.Pane(pane).Terminal.CoreID
	}
	if workspace == "" && group != "" {
		for _, m := range a.coreState.Machines {
			if m.Name == group && m.State == "connected" {
				on = m.ID
				break
			}
		}
	}
	if group != "" && on == "" {
		a.navigationNote = "Core machine identity unavailable"
		return
	}
	o := core.TerminalRunParams{CWD: core.Optional(cwd), On: core.Optional(on)}
	a.coreNavigation++
	intent := a.coreNavigation
	n := a.beginCoreCapture("", true)
	if on != "" && on != a.coreState.Layout.CoreID {
		a.cancelCoreCapture()
	}
	a.corePending = true
	a.coreSelect(nil)
	if a.navigationNote == "" {
		a.navigationNote = "Creating terminal; input paused"
	}
	a.coreRunCapture(s, intent, n, o, "", func(l *core.Layout, added core.Pane, record core.Terminal) error {
		if pane != "" {
			return l.SplitPane(pane, direction, added)
		}
		if workspace == "" {
			l.AddWorkspace("", record.CWD, group, added)
			return nil
		}
		_, err := l.AddTab(workspace, "", added)
		return err
	})
}

func (a *App) coreRunCapture(s *core.Session, intent uint64, n *coreCapture, o core.TerminalRunParams, outcome string, insert func(*core.Layout, core.Pane, core.Terminal) error) {
	before := s.State().Terminals
	o.Labels = withSeenZero(o.Labels)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		record, ref, err := s.Run(ctx, o)
		if _, exists := before[ref.Address]; err == nil && exists {
			err = errors.New("Core creation returned an existing terminal")
		}
		if err != nil {
			a.failCoreCreation(s, intent, outcome+err.Error())
			return
		}
		added := core.NewPane(ref)
		err = s.Edit(ctx, func(l *core.Layout) error { return insert(l, added, record) })
		if err != nil {
			a.failCoreCreation(s, intent, outcome+"Created "+record.Address+" but did not add it: "+err.Error())
			return
		}
		a.mu.Lock()
		if a.coreSession == s {
			a.coreApply(s)
			if a.coreNavigation == intent {
				if a.bindCoreCapture(n, &added) {
					if a.navigationNote == "Creating terminal; input paused" {
						a.navigationNote = ""
					}
					a.corePending = false
					_ = a.coreSelection.SelectPane(&a.coreState.Layout, added.ID)
					a.coreChrome()
					a.coreFocus()
					a.returnFocus = n == nil && a.dialog == nil && a.nativeDialog == nil
				} else {
					a.cancelCoreCapture()
				}
			}
		}
		a.mu.Unlock()
		a.invalidate()
	}()
}

func (a *App) coreClose(ids []string) {
	s := a.coreSession
	if s == nil || !a.coreState.Connected || len(a.coreClosing) > 0 || a.dialog != nil || a.nativeDialog != nil {
		return
	}
	refs := map[string]core.TerminalRef{}
	programs := map[string]uint64{}
	for _, id := range ids {
		if p := a.coreState.Layout.Pane(id); p != nil {
			refs[id] = p.Terminal
			programs[id] = a.coreState.Programs[p.Terminal.Address]
		}
	}
	if len(refs) == 0 {
		return
	}
	a.coreClosing = slices.Clone(ids)
	active := true
	a.coreSelect(nil)
	a.confirm("Close terminal?", "This ends the selected terminal programs, including any other viewers. Unreported activity is unknown, not idle.", "Close", func() {
		if !active {
			return
		}
		active = false
		if a.coreSession != s || a.windowClosed {
			a.coreClosing = nil
			a.toast = "Not closed: connection changed"
			return
		}
		state := s.State()
		for id, ref := range refs {
			p := state.Layout.Pane(id)
			_, exists := state.Terminals[ref.Address]
			if !state.Connected || p == nil || p.Terminal != ref || state.Programs[ref.Address] != programs[id] || (!strings.Contains(ref.Address, "/") && !exists) {
				a.coreClosing = nil
				a.toast = "Not closed: pane changed"
				return
			}
		}
		a.coreNavigation++
		intent := a.coreNavigation
		a.corePending = true
		a.coreSelect(nil)
		go func() {
			defer func() {
				a.mu.Lock()
				a.coreClosing = nil
				if a.coreSession == s && a.coreNavigation == intent {
					a.corePending = false
					a.coreApply(s)
					a.returnFocus = true
				}
				a.mu.Unlock()
				a.invalidate()
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			killed := map[core.TerminalRef]bool{}
			for _, ref := range refs {
				if killed[ref] {
					continue
				}
				if err := s.Kill(ctx, ref); err != nil {
					a.coreNote(s, "Close stopped: "+err.Error())
					return
				}
				killed[ref] = true
			}
			err := s.Edit(ctx, func(l *core.Layout) error {
				for id, ref := range refs {
					if p := l.Pane(id); p != nil {
						if p.Terminal != ref {
							return core.ErrOwnership
						}
						if err := l.RemovePane(id); err != nil {
							return err
						}
					}
				}
				return nil
			})
			if err != nil {
				a.coreNote(s, "Terminal ended; layout removal failed: "+err.Error())
				return
			}
		}()
	}, func() {
		if active {
			active = false
			a.coreClosing = nil
		}
		a.coreFocus()
		a.returnFocus = true
	})
}
func (a *App) coreCloseGroup(workspace, tab string) {
	if workspace == "" && tab == "" {
		return
	}
	var ids []string
	for _, w := range a.coreState.Layout.Workspaces {
		if workspace != "" && w.ID != workspace {
			continue
		}
		for _, t := range w.Tabs {
			if tab != "" && t.ID != tab {
				continue
			}
			walkCorePanes(t.Root, func(p *core.Pane) { ids = append(ids, p.ID) })
		}
	}
	a.coreClose(ids)
}
func (a *App) coreRename(id, label string) {
	a.coreEdit(func(l *core.Layout) error { return l.Rename(id, label) })
}
func (a *App) coreMoveTab(id string, index int) {
	a.coreEdit(func(l *core.Layout) error {
		to := index
		for _, w := range l.Workspaces {
			for i, t := range w.Tabs {
				if t.ID == id && to > i {
					to--
					break
				}
			}
		}
		return l.MoveTab(id, to)
	})
}
func (a *App) coreSetRatio(tab string, path []bool, value float32) {
	path = slices.Clone(path)
	t := a.coreState.Layout.Tab(tab)
	if t == nil {
		return
	}
	before := t.Root
	a.coreEdit(func(l *core.Layout) error {
		current := l.Tab(tab)
		if current == nil || !reflect.DeepEqual(current.Root, before) {
			return errors.New("Layout changed; split resize not applied")
		}
		return l.SetRatio(tab, path, float64(value))
	})
}
func (a *App) coreUnavailable(feature string) {
	a.navigationNote = feature + " is not available in the Core frontend yet"
	a.invalidate()
}

func (a *App) coreAttach(id string, opts terminal.Options) {
	if n := a.coreCapture; n != nil && n.pane == id && n.awaitProgram {
		return
	}
	if a.coreSession == nil || a.coreViews[id] != nil || a.coreLoading[id] || a.coreErrors[id] != "" {
		return
	}
	s := a.coreSession
	pane := a.coreState.Layout.Pane(id)
	if pane == nil {
		return
	}
	ref := pane.Terminal
	a.coreLoading[id] = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		v, err := s.Attach(ctx, id, core.TerminalAttachParams{Cols: 80, Rows: 24, History: 2000})
		var view *coreview.Terminal
		if err == nil {
			opts.NoClipboardWrite = true
			opts.ClipboardRead = terminal.ClipboardDeny
			opts.ImageLimit = 16 << 20
			opts.OnExit = func(int) { a.invalidate() }
			var wasReady bool
			opts.OnPaint = func(_, _, _, _ int) {
				if view != nil {
					ready := view.InputReady()
					if wasReady != ready {
						wasReady = ready
						a.invalidate()
					}
				}
			}
			opts.ProgramRightClick = func() bool {
				a.mu.Lock()
				defer a.mu.Unlock()
				return a.coreSession == s && a.coreAttached[id] == ref && a.coreViews[id] == view && view != nil && view.InputReady() && a.coreCapture == nil && !a.coreBlocked && !a.corePending && a.rightToPane[id]
			}
			opts.ExtendMenu = func(m *ui.Menu) {
				if a.coreSession != s || a.coreAttached[id] != ref || a.coreViews[id] != view {
					return
				}
				was := a.menuPane
				a.menuPane = id
				a.paneMenu(m)
				a.menuPane = was
			}
			opts.OpenLink = func(raw string) bool {
				a.mu.Lock()
				if a.coreSession != s || a.coreViews[id] != view || a.coreAttached[id] != ref {
					a.mu.Unlock()
					return true
				}
				record := a.coreState.Terminals[ref.Address]
				cwd := record.CWD
				if ref.CoreID == a.coreState.Layout.CoreID && record.Foreground != nil && filepath.IsAbs(record.Foreground.CWD) && gitTextPath(record.Foreground.CWD) == nil {
					cwd = record.Foreground.CWD
				}
				if cwd == "" {
					workspace, _ := a.coreState.Layout.Location(id)
					for _, w := range a.coreState.Layout.Workspaces {
						if w.ID == workspace && w.Machine == "" {
							cwd = w.CWD
						}
					}
				}
				file, line, column := coreFilePosition(raw)
				target, err := coreLinkURL(raw, cwd, ref.CoreID == a.coreState.Layout.CoreID)
				if line > 0 && err == nil {
					target, err = coreLinkURL(file, cwd, ref.CoreID == a.coreState.Layout.CoreID)
					if err == nil {
						u, _ := url.Parse(target)
						if a.coreSelection.Pane != id {
							a.ShowPane(id)
							if a.coreSelection.Pane != id {
								a.mu.Unlock()
								return true
							}
							a.coreEditorClick = id
						}
						a.openEditorBound(id, s, ref, view, editorRequest{Path: u.Path, Line: line, Column: column}, nil)
						a.mu.Unlock()
						return true
					}
				}
				if err == nil {
					a.open = append(a.open, target)
				} else {
					a.navigationNote = "Link not opened: " + err.Error()
				}
				a.mu.Unlock()
				a.invalidate()
				return true
			}
			paste := func() func(string) bool {
				if view == nil || !view.InputReady() {
					a.coreNote(s, "Paste refused: terminal input is not available")
					return nil
				}
				return view.VT.CapturePaste()
			}
			opts.OnDropFiles = func(paths []string) bool {
				send := paste()
				if send == nil {
					return true
				}
				text, err := quotePaths(paths, quotePOSIX)
				if err != nil {
					a.coreNote(s, pasteRefusal(err))
					return true
				}
				if !send(text) {
					a.coreNote(s, "Paste refused: input ownership changed or capacity exceeded")
				}
				return true
			}
			opts.PreparePaste = func() func(transfer.Data) bool {
				if view == nil || !view.InputReady() {
					a.coreNote(s, "Paste refused: terminal input is not available")
					return nil
				}
				input, ok := a.coreKeyboard.CaptureFor(view.Viewer)
				send := paste()
				if !ok || send == nil {
					return nil
				}
				current := func() bool { return input.Valid() && view.InputReady() }
				return func(d transfer.Data) bool {
					if !current() {
						a.coreNote(s, "Paste refused: input ownership changed")
						return true
					}
					text, err := d.Read(transfer.Text)
					if err != nil && !errors.Is(err, transfer.ErrFormat) {
						a.coreNote(s, "Clipboard could not be read")
						return true
					}
					if !current() {
						a.coreNote(s, "Paste refused: input ownership changed")
						return true
					}
					if len(text) == 0 {
						paths, e := clipboardPaths(d)
						if e != nil {
							a.coreNote(s, "Clipboard could not be read")
							return true
						}
						quoted, e := quotePaths(paths, quoteBackslash)
						if e != nil {
							a.coreNote(s, pasteRefusal(e))
							return true
						}
						text = []byte(quoted)
					}
					if len(text) > navigationBytes {
						a.coreNote(s, "Paste refused: text is too long")
						return true
					}
					if !current() || len(text) > 0 && !send(string(text)) {
						a.coreNote(s, "Paste refused: input ownership changed or capacity exceeded")
					}
					return true
				}
			}
			opts.OnMenuClear = func() bool {
				return a.coreSession != s || a.coreViews[id] != view || a.coreAttached[id] != ref || !a.coreTargetActionAllowed()
			}
			opts.OnClear = func(terminal.Clear) bool { return view == nil || !view.InputReady() }
			opts.OnKey = func(mods ui.Modifiers, key ui.Key) bool {
				a.mu.Lock()
				defer a.mu.Unlock()
				return a.cancelTabPress(ui.InputEvent{Kind: ui.InputKeyDown, Key: key, Mods: mods})
			}
			opts.OnInputError = func(err error) { a.coreNote(s, "Input to "+ref.Address+": "+err.Error()) }
			view, err = coreview.New(v, &a.coreKeyboard, opts)
			if err != nil {
				v.Close()
			}
		}
		a.mu.Lock()
		if a.coreSession != s {
			a.mu.Unlock()
			if view != nil {
				view.Close()
			}
			return
		}
		delete(a.coreLoading, id)
		if err != nil {
			a.coreErrors[id] = err.Error()
			if n := a.coreCapture; n != nil && n.pane == id {
				a.cancelCoreCapture()
				if a.navigationNote != navigationLost {
					a.navigationNote = "Input paused: " + err.Error()
				}
			}
		} else if p := a.coreState.Layout.Pane(id); p == nil || p.Terminal != ref {
			go view.Close()
		} else {
			a.coreViews[id] = view
			a.coreAttached[id] = ref
			a.coreFocus()
		}
		a.mu.Unlock()
		a.invalidate()
	}()
}

func coreWaiting(address string) string { return fmt.Sprintf("Waiting for Core terminal %s", address) }

func (a *App) coreEditAndFollow(pane string, change func(*core.Layout) error) {
	s := a.coreSession
	if s == nil {
		a.err = "Not connected to Core"
		return
	}
	a.coreNavigation++
	intent := a.coreNavigation
	a.corePending = true
	a.coreSelect(nil)
	a.navigationNote = "Moving pane; input paused"
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.Edit(ctx, change); err != nil {
			a.coreNote(s, err.Error())
			return
		}
		a.mu.Lock()
		if a.coreSession == s {
			a.coreApply(s)
			if a.coreNavigation == intent {
				a.navigationNote = ""
				a.coreNavigate(func(sel *core.Selection, l *core.Layout) error { return sel.SelectPane(l, pane) })
			}
		}
		a.mu.Unlock()
		a.invalidate()
	}()
}

func (a *App) coreFocusLoop(ctx context.Context, s *core.Session) {
	var sent *coreview.Terminal
	for {
		a.mu.Lock()
		current := a.coreSession == s
		want := a.coreSelected
		a.mu.Unlock()
		if !current {
			return
		}
		target, focused := sent, false
		if sent == want {
			select {
			case <-ctx.Done():
				return
			case <-s.Done():
				return
			case <-a.coreFocusWake:
			}
			continue
		}
		if sent == nil {
			target, focused = want, true
		}
		err := target.Viewer.Focus(focused)
		if errors.Is(err, core.ErrBusy) {
			a.coreNote(s, "Terminal focus report delayed by Core capacity")
			select {
			case <-ctx.Done():
				return
			case <-s.Done():
				return
			case <-a.coreFocusWake:
			case <-time.After(100 * time.Millisecond):
			}
			continue
		}
		if err != nil && !errors.Is(err, core.ErrClosed) {
			a.coreNote(s, "Terminal focus report failed: "+err.Error())
			return
		}
		if focused {
			sent = target
		} else {
			sent = nil
		}
	}
}
