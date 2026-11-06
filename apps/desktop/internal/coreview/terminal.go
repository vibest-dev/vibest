package coreview

import (
	"bytes"
	"errors"
	"io"
	"sync"
	"sync/atomic"

	"vibest-desktop/internal/core"

	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
)

type Terminal struct {
	VT         *terminal.Terminal
	Viewer     *core.Viewer
	keyboard   *core.Keyboard
	fitted     atomic.Bool
	visible    func() bool
	frameOwner core.Owner
	mode       atomic.Uint32
	modeTail   []byte
}

func New(v *core.Viewer, k *core.Keyboard, opts terminal.Options) (*Terminal, error) {
	t := &Terminal{Viewer: v, keyboard: k}
	conn := &connection{terminal: t, ready: make(chan struct{})}
	opts.Conn = conn
	opts.InputLimit = core.MaxInputBytes
	opts.TextInputReady = t.InputReady
	output := opts.OnOutput
	opts.OnOutput = func(p []byte) {
		scan := append(t.modeTail, p...)
		if bytes.Contains(scan, []byte("\x1b[?9001h")) {
			t.mode.Store(2)
		} else if t.mode.Load() != 2 && bytes.Contains(scan, []byte("\x1b[?9001l")) {
			t.mode.Store(1)
		}
		t.modeTail = append([]byte(nil), scan[max(0, len(scan)-7):]...)
		if output != nil {
			output(p)
		}
	}
	opts.CaptureInput = func() io.Writer {
		if t.mode.Load() != 1 {
			return nil
		}
		input, ok := k.CaptureFor(v)
		if !ok {
			return nil
		}
		return captured{input: input, terminal: t}
	}
	painted := opts.OnPaint
	opts.OnPaint = func(cols, rows, cellWidth, cellHeight int) {
		t.fitted.Store(t.mode.Load() == 1 && cols > 0 && rows > 0 && cellWidth > 0 && cellHeight > 0 && t.visible != nil && t.visible())
		if t.fitted.Load() {
			k.Rendered(t.frameOwner, cols, rows, cellWidth, cellHeight)
		} else {
			k.Rendered(t.frameOwner, 0, 0, 0, 0)
		}
		if painted != nil {
			painted(cols, rows, cellWidth, cellHeight)
		}
	}
	vt, err := terminal.New(opts)
	if err != nil {
		v.Close()
		return nil, err
	}
	t.VT = vt
	vt.Resize(int(v.Terminal.Cols), int(v.Terminal.Rows))
	close(conn.ready)
	return t, nil
}
func (t *Terminal) Select() { t.fitted.Store(false); t.keyboard.Select(t.Viewer); t.VT.CancelInput() }
func (t *Terminal) Cancel() { t.fitted.Store(false); t.keyboard.Deselect(t.Viewer); t.VT.CancelInput() }

func (t *Terminal) Fitted() bool { return t.fitted.Load() && t.visible != nil && t.visible() }

func (t *Terminal) CancelComposition() { t.keyboard.Invalidate(t.Viewer); t.VT.CancelInput() }
func (t *Terminal) Close() error       { return t.VT.Close() }

func (t *Terminal) InputReady() bool {
	if t.mode.Load() != 1 {
		return false
	}
	_, ok := t.keyboard.CaptureFor(t.Viewer)
	return ok
}

func (t *Terminal) InputError() error {
	if err := t.Viewer.InputError(); err != nil {
		return err
	}
	if t.mode.Load() == 2 {
		return errors.New("Core terminal requires win32 input mode 9001; MyGo0.6 encoding is not supported")
	}
	return nil
}
func (t *Terminal) View(c *ui.Context) ui.Element {
	e := terminal.View(c, t.VT)
	bounds := ui.Local(e, "input-bounds", func() ui.Handle { return ui.Handle{} })
	e.Bind(bounds)
	w, h := c.Size()
	visible := func() bool {
		r := bounds.Bounds(c)
		return r.W > 0 && r.H > 0 && r.X >= 0 && r.Y >= 0 && r.X+r.W <= w+.5 && r.Y+r.H <= h+.5
	}
	t.visible = visible
	shown := visible()
	if !shown {
		t.fitted.Store(false)
	}
	if !shown && t.InputReady() {
		t.CancelComposition()
	}
	owner := t.keyboard.OwnerFor(t.Viewer)
	t.frameOwner = owner
	e.TextInputSession(owner)
	ready := t.InputReady()
	if !shown || !ready {
		e.InputMethod(false)
	}
	return e.PrepareInput(func() bool {
		now := visible()
		if !now && t.InputReady() {
			t.CancelComposition()
		}
		return t.keyboard.OwnerFor(t.Viewer) != owner || now != shown || t.InputReady() != ready
	})
}

type connection struct {
	terminal *Terminal
	ready    chan struct{}
	mu       sync.Mutex
	display  core.Display
}

func (c *connection) Read(p []byte) (int, error) {
	<-c.ready
	return c.terminal.Viewer.Read(p)
}

func (c *connection) Write(p []byte) (int, error) { return 0, core.ErrOwnership }
func (c *connection) Close() error                { return c.terminal.Viewer.Close() }
func (c *connection) Resize(cols, rows int) error { return c.terminal.Viewer.Resize(cols, rows) }
func (c *connection) ResizePixels(cols, rows, cw, ch int) error {
	if err := c.terminal.Viewer.Resize(cols, rows); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.display.Cell = &[2]uint32{uint32(cw), uint32(ch)}
	return c.terminal.Viewer.SetDisplay(c.display)
}
func (c *connection) UseTheme(th *terminal.Theme) error {
	if th == nil {
		return nil
	}
	hex := func(c ui.Color) string {
		const digits = "0123456789abcdef"
		b := []byte{'#', digits[c.R>>4], digits[c.R&15], digits[c.G>>4], digits[c.G&15], digits[c.B>>4], digits[c.B&15]}
		return string(b)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.display.FG, c.display.BG, c.display.Cursor = hex(th.Foreground), hex(th.Background), hex(th.Cursor)
	return c.terminal.Viewer.SetDisplay(c.display)
}

type captured struct {
	input    core.Input
	terminal *Terminal
}

func (c captured) Write(p []byte) (int, error) {
	if c.terminal.mode.Load() != 1 || !c.input.Valid() {
		return 0, terminal.ErrInputCanceled
	}
	if len(p) == 0 {
		return 0, nil
	}
	n, err := c.input.Write(p)
	if errors.Is(err, core.ErrBusy) {
		return n, terminal.ErrInputFull
	}
	if errors.Is(err, core.ErrOwnership) || errors.Is(err, core.ErrClosed) {
		return 0, terminal.ErrInputCanceled
	}
	return n, err
}
