package herdr

const msgPatch = 19

type RGB struct{ R, G, B uint8 }

type Target struct {
	ID    string
	Popup bool
}

type InputEvent interface{ encode(*enc) }

const (
	KeyBackspace = iota
	KeyEnter
	KeyLeft
	KeyRight
	KeyUp
	KeyDown
	KeyHome
	KeyEnd
	KeyPageUp
	KeyPageDown
	KeyTab
	KeyBackTab
	KeyDelete
	KeyInsert
	KeyEsc
	KeyChar
	KeyF
)

const (
	ModShift = 1
	ModCtrl  = 2
	ModAlt   = 4
	ModSuper = 8
)

type Key struct {
	Code   int
	Char   rune
	F      uint8
	Mods   uint8
	Repeat bool
}

func (k Key) encode(e *enc) {
	e.uint(0)
	e.uint(uint64(k.Code))
	switch k.Code {
	case KeyChar:
		e.char(k.Char)
	case KeyF:
		e.u8(k.F)
	}
	e.u8(k.Mods)
	if k.Repeat {
		e.uint(1)
	} else {
		e.uint(0)
	}
	e.uint(1)
	e.none()
	e.none()
	e.boolean(false)
	e.none()
	e.none()
}

type Text string

func (t Text) encode(e *enc) { e.uint(1); e.str(string(t)) }

type Paste string

func (p Paste) encode(e *enc) { e.uint(3); e.str(string(p)) }

const (
	MouseDown = iota
	MouseUp
	MouseDrag
	MouseMoved
	MouseScrollUp
	MouseScrollDown
)

type Mouse struct {
	Kind, Button int
	Col, Row     int
	Mods         uint8
	Lines        int
}

func (m Mouse) encode(e *enc) {
	e.uint(2)
	e.uint(uint64(m.Kind))
	if m.Kind <= MouseDrag {
		e.uint(uint64(m.Button))
	}
	e.uint(0)
	e.uint(uint64(m.Col))
	e.uint(uint64(m.Row))
	e.none()
	e.u8(m.Mods)
	e.uint(uint64(max(m.Lines, 1)))
}
