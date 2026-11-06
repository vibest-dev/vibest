package app

import (
	"context"
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/core"
)

type coreCapture struct {
	session      *core.Session
	intent       uint64
	pane         string
	ref          core.TerminalRef
	program      uint64
	creating     bool
	awaitProgram bool
	programs     map[string]uint64
	existing     map[string]core.Terminal
	events       []terminal.Input
	bytes        int
	count        int
	composing    bool
	meaningful   bool
	pending      *ui.InputEvent
	pressed      map[ui.Key]bool
	focus        bool
	ctx          context.Context
	cancel       context.CancelFunc
	stop         func() bool
}

func (a *App) beginCoreCapture(pane string, creating bool) *coreCapture {
	a.cancelCoreCapture()
	a.coreFence = nil
	a.coreBlocked = false
	a.navigationGeneration++
	if a.dialog != nil || a.nativeDialog != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), navigationTimeout)
	n := &coreCapture{session: a.coreSession, intent: a.coreNavigation, pane: pane, creating: creating, ctx: ctx, cancel: cancel, focus: true}
	state := a.coreSession.State()
	if creating {
		n.programs, n.existing = state.Programs, state.Terminals
	} else if p := state.Layout.Pane(pane); p != nil {
		n.ref = p.Terminal
		n.program = state.Programs[n.ref.Address]
	}
	a.coreCapture = n
	n.stop = context.AfterFunc(ctx, func() {
		a.mu.Lock()
		if a.coreCapture == n {
			a.cancelCoreCapture()
		}
		a.mu.Unlock()
		a.invalidate()
	})
	if !creating && n.ref.CoreID != state.Layout.CoreID {
		a.cancelCoreCapture()
		a.navigationNote = core.ErrRemoteInput.Error()
	}
	return n
}
func (a *App) cancelCoreCapture() {
	if n := a.coreCapture; n != nil {
		if n.meaningful || n.composing {
			a.navigationNote = navigationLost
		}
		if n.stop != nil {
			n.stop()
		}
		n.cancel()
		n.events = nil
		n.bytes = 0
		n.count = 0
		n.composing = false
		n.pending = nil
		n.pressed = nil
		a.coreCapture = nil
		a.coreFence = n
		a.coreBlocked = true
		a.returnFocus = false
		a.navigationGeneration++
		a.coreSelect(nil)
	}
}
func (a *App) validCoreCapture(n *coreCapture) bool {
	if n == nil || n.session != a.coreSession || a.windowClosed {
		return false
	}
	state := n.session.State()
	if !state.Connected {
		return false
	}
	if n.pane == "" {
		return n.creating && a.coreNavigation == n.intent
	}
	p := state.Layout.Pane(n.pane)
	if p == nil || p.Terminal != n.ref || a.coreSelection.Pane != n.pane {
		return false
	}
	current := state.Programs[n.ref.Address]
	if n.awaitProgram {
		_, exists := state.Terminals[n.ref.Address]
		if current == n.program && exists {
			if a.coreState.Programs[n.ref.Address] == n.program {
				n.awaitProgram = false
			}
		} else {
			return current+1 == n.program && !exists
		}
	}
	return current == n.program
}
func (a *App) resumeCoreCapture() {
	if a.coreFence != nil && a.validCoreCapture(a.coreFence) && a.coreFence.pane != "" && a.coreViews[a.coreFence.pane] != nil && a.coreViews[a.coreFence.pane].Fitted() {
		a.coreFence = nil
		a.coreBlocked = false
	}
}
func (a *App) failCoreCreation(s *core.Session, intent uint64, text string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if s != a.coreSession {
		return
	}
	a.coreOperationNote = text
	if a.coreNavigation == intent {
		a.cancelCoreCapture()
		a.corePending = true
		a.coreBlocked = true
		a.coreSelect(nil)
		if a.navigationNote == "Creating terminal; input paused" {
			a.navigationNote = ""
		}
	}
	a.invalidate()
}

func (a *App) bindCoreCapture(n *coreCapture, p *core.Pane) bool {
	if n == nil {
		return true
	}
	if n.session != a.coreSession || n.intent != a.coreNavigation {
		return false
	}
	if _, existed := n.existing[p.Terminal.Address]; existed {
		return false
	}
	n.pane, n.ref, n.program = p.ID, p.Terminal, n.programs[p.Terminal.Address]+1
	n.creating = false
	n.awaitProgram = true
	n.programs = nil
	n.existing = nil
	return true
}
func (a *App) coreCaptureView(c *ui.Context) {
	a.g.services = c.Services()
	n := a.coreCapture
	if n != nil && (n.ctx.Err() != nil || !a.validCoreCapture(n) || a.dialog != nil || a.nativeDialog != nil) {
		a.cancelCoreCapture()
		n = nil
	}
	if a.dialog != nil || a.nativeDialog != nil {
		return
	}
	if n == nil && !a.coreBlocked {
		return
	}
	key := a.coreNavigation
	if a.coreFence != nil {
		key = a.coreFence.intent
	}
	if n != nil {
		key = n.intent
	}
	sink := ui.Box(c).Key(key).Absolute().Size(1, 1).Focusable().FocusRing(false).Label("navigation-input").TextInputSession(n)
	if n != nil && !n.focus && !sink.Focused() {
		a.cancelCoreCapture()
		n = nil
	}
	if n != nil {
		if a.flushCoreCapture(n) {
			c.Invalidate()
			return
		}
		sink.TextCaret(ui.Rect{W: 1, H: 16})
		if n.focus {
			sink.Focus()
			n.focus = false
		}
	} else {
		sink.InputMethod(false)
	}
	owner := n
	sink.PrepareInput(func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		if owner != a.coreCapture {
			return true
		}
		if owner == nil {
			return false
		}
		v := a.coreViews[owner.pane]
		return owner.ctx.Err() != nil || !a.validCoreCapture(owner) || v != nil && v.InputReady() && !owner.composing && owner.pending == nil
	})
	sink.HandleInput(func(ev ui.InputEvent) bool { return a.coreCaptureInput(owner, ev) })
}
func (a *App) coreCaptureInput(owner *coreCapture, ev ui.InputEvent) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if owner == nil || owner != a.coreCapture {
		a.dropped(ev)
		return ev.Mods&ui.Super == 0
	}
	if owner.ctx.Err() != nil || !a.validCoreCapture(owner) {
		a.cancelCoreCapture()
		a.dropped(ev)
		return ev.Mods&ui.Super == 0
	}
	n := owner
	input := terminal.Input{InputEvent: ev}
	switch ev.Kind {
	case ui.InputCompose:
		n.pending = nil
		n.composing = ev.Text != ""
		return true
	case ui.InputText:
		n.composing = false
		if n.pending != nil {
			input.Key, input.Mods, input.Repeat = n.pending.Key, n.pending.Mods, n.pending.Repeat
			n.pending = nil
			if n.pressed == nil {
				n.pressed = map[ui.Key]bool{}
			}
			n.pressed[input.Key] = true
		}
	case ui.InputKeyDown, ui.InputKeyUp:
		if ev.Mods == ui.Super && ev.Key == ui.KeyV {
			if ev.Kind == ui.InputKeyUp {
				return true
			}
			input = terminal.Input{InputEvent: ui.InputEvent{Kind: ui.InputText}, Paste: true}
		} else if ev.Mods&ui.Super != 0 {
			return false
		} else if ev.Kind == ui.InputKeyUp {
			if n.pending != nil && n.pending.Key == ev.Key {
				n.pending = nil
				return true
			}
			if !n.pressed[ev.Key] {
				return true
			}
			delete(n.pressed, ev.Key)
		} else {
			if keyRunes[ev.Key] != 0 && ev.Mods&ui.Ctrl == 0 && (ev.Mods&ui.Alt == 0 || !a.look.OptionAsAlt) {
				n.pending = &ev
				return true
			}
			if _, special := specialKeys[ev.Key]; !special && keyRunes[ev.Key] == 0 && (ev.Key < ui.KeyF1 || ev.Key > ui.KeyF12) {
				return false
			}
			if n.pressed == nil {
				n.pressed = map[ui.Key]bool{}
			}
			n.pressed[ev.Key] = true
		}
	case ui.InputCommand:
		if ev.Text != "paste" && ev.Text != "pasteAndMatchStyle" {
			return false
		}
		input = terminal.Input{InputEvent: ui.InputEvent{Kind: ui.InputText}, Paste: true}
	default:
		return false
	}
	if input.Paste {
		var err error
		input.Text, err = a.clipboardPasteText()
		if err != nil {
			a.cancelCoreCapture()
			a.unsent()
			a.invalidate()
			return true
		}
	}
	meaningful := input.Kind != ui.InputKeyUp
	if meaningful && n.count >= navigationEvents || n.bytes+len(input.Text) > navigationBytes {
		a.cancelCoreCapture()
		a.unsent()
		a.invalidate()
		return true
	}
	n.meaningful = n.meaningful || input.Kind == ui.InputKeyDown || input.Text != ""
	n.events = append(n.events, input)
	n.bytes += len(input.Text)
	if meaningful {
		n.count++
	}
	a.flushCoreCapture(n)
	a.invalidate()
	return true
}

func (a *App) flushCoreCapture(n *coreCapture) bool {
	if n == nil || a.coreCapture != n || n.composing || n.pending != nil {
		return false
	}
	if n.ctx.Err() != nil || !a.validCoreCapture(n) {
		a.cancelCoreCapture()
		return true
	}
	v := a.coreViews[n.pane]
	if n.awaitProgram || v == nil || !v.InputReady() {
		return false
	}
	if !v.VT.SendInput(n.events) {
		a.cancelCoreCapture()
		a.unsent()
	} else {
		n.stop()
		n.cancel()
		n.events = nil
		n.bytes = 0
		n.count = 0
		n.pending = nil
		n.pressed = nil
		a.coreCapture = nil
		a.coreFence = nil
		a.coreBlocked = false
		a.returnFocus = true
	}
	return true
}

func (a *App) coreTargetActionAllowed() bool {
	if a.coreCapture != nil || a.coreBlocked || a.corePending {
		a.cancelNavigation()
		return false
	}
	return true
}
