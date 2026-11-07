package app

import (
	"errors"
	"log"

	"os"
	"strings"
	"unicode/utf8"

	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
)

var specialKeys = map[ui.Key]bool{
	ui.KeyEnter: true, ui.KeyEscape: true, ui.KeyBackspace: true,
	ui.KeyTab: true, ui.KeyDelete: true, ui.KeyInsert: true,
	ui.KeyHome: true, ui.KeyEnd: true, ui.KeyPageUp: true,
	ui.KeyPageDown: true, ui.KeyLeft: true, ui.KeyRight: true,
	ui.KeyUp: true, ui.KeyDown: true,
}

var keyRunes = func() map[ui.Key]rune {
	m := map[ui.Key]rune{
		ui.KeySpace: ' ', ui.KeyMinus: '-', ui.KeyEqual: '=', ui.KeyComma: ',', ui.KeyPeriod: '.',
		ui.KeySlash: '/', ui.KeySemicolon: ';', ui.KeyQuote: '\'', ui.KeyBracketLeft: '[',
		ui.KeyBracketRight: ']', ui.KeyBackslash: '\\', ui.KeyBackquote: '`',
	}
	letters := []ui.Key{ui.KeyA, ui.KeyB, ui.KeyC, ui.KeyD, ui.KeyE, ui.KeyF, ui.KeyG, ui.KeyH, ui.KeyI,
		ui.KeyJ, ui.KeyK, ui.KeyL, ui.KeyM, ui.KeyN, ui.KeyO, ui.KeyP, ui.KeyQ, ui.KeyR, ui.KeyS,
		ui.KeyT, ui.KeyU, ui.KeyV, ui.KeyW, ui.KeyX, ui.KeyY, ui.KeyZ}
	for i, k := range letters {
		m[k] = rune('a' + i)
	}
	digits := []ui.Key{ui.Key0, ui.Key1, ui.Key2, ui.Key3, ui.Key4, ui.Key5, ui.Key6, ui.Key7, ui.Key8, ui.Key9}
	for i, k := range digits {
		m[k] = rune('0' + i)
	}
	return m
}()

func typedInput(ev ui.InputEvent) bool {
	switch ev.Kind {
	case ui.InputText:
		return ev.Text != ""
	case ui.InputCommand:
		return ev.Text == "paste" || ev.Text == "pasteAndMatchStyle"
	case ui.InputKeyDown:
		if ev.Mods&ui.Super != 0 {
			return ev.Mods == ui.Super && (ev.Key == ui.KeyV || ev.Key == ui.KeyLeft || ev.Key == ui.KeyRight || ev.Key == ui.KeyBackspace)
		}
		return specialKeys[ev.Key] || ev.Key >= ui.KeyF1 && ev.Key <= ui.KeyF12 || keyRunes[ev.Key] != 0 && ev.Mods&ui.Ctrl != 0
	}
	return false
}

const (
	maxPastePaths = 256
	maxPasteBytes = 64 << 10
)

var (
	errPasteTooMany = errors.New("too many files")
	errPastePath    = errors.New("a path is not valid text")
	errPasteControl = errors.New("a path contains a control character")
	errPasteTooLong = errors.New("paths are too long")
)

type pathQuote uint8

const (
	quoteBackslash pathQuote = iota
	quotePOSIX
)

func quotePaths(paths []string, style pathQuote) (string, error) {
	if len(paths) == 0 {
		return "", nil
	}
	if len(paths) > maxPastePaths {
		return "", errPasteTooMany
	}
	var b strings.Builder
	for i, p := range paths {
		if !utf8.ValidString(p) {
			return "", errPastePath
		}
		for _, r := range p {
			if r < 0x20 || r == 0x7f {
				return "", errPasteControl
			}
		}
		if i > 0 {
			b.WriteByte(' ')
		}
		switch style {
		case quoteBackslash:
			writeShellEscape(&b, p)
		case quotePOSIX:
			b.WriteByte('\'')
			b.WriteString(strings.ReplaceAll(p, "'", `'\''`))
			b.WriteByte('\'')
		default:
			return "", errPastePath
		}
		if b.Len() > maxPasteBytes {
			return "", errPasteTooLong
		}
	}
	return b.String(), nil
}

func pasteRefusal(err error) string {
	switch {
	case errors.Is(err, errPasteTooMany):
		return "Too many files to paste"
	case errors.Is(err, errPastePath):
		return "A file path is not valid text"
	case errors.Is(err, errPasteControl):
		return "A file path contains a control character"
	case errors.Is(err, errPasteTooLong):
		return "File paths are too long to paste"
	default:
		return "Could not paste the files"
	}
}

func (a *App) clipboardPasteText() (string, error) {
	if s := a.g.services.ReadClipboard(); s != "" {
		return s, nil
	}
	paths, err := clipboardPaths(a.g.services.ReadClipboardData(transfer.FileList, transfer.URIList, transfer.PNG))
	if err != nil {
		log.Println("paste clipboard:", err)
		return "", err
	}
	return quotePaths(paths, quoteBackslash)
}

func clipboardPaths(d transfer.Data) ([]string, error) {
	if files, err := d.Files(); err != nil && !errors.Is(err, transfer.ErrFormat) {
		return nil, err
	} else if len(files) > 0 {
		return files, nil
	}
	png, err := d.Read(transfer.PNG)
	if err != nil && !errors.Is(err, transfer.ErrFormat) {
		return nil, err
	}
	if len(png) == 0 {
		return nil, nil
	}
	f, err := os.CreateTemp("", "herdr-paste-*.png")
	if err != nil {
		return nil, err
	}
	_, err = f.Write(png)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(f.Name())
		return nil, err
	}
	return []string{f.Name()}, nil
}

func shellEscape(p string) string {
	var b strings.Builder
	writeShellEscape(&b, p)
	return b.String()
}

func writeShellEscape(b *strings.Builder, p string) {
	for _, r := range p {
		if r < 0x80 && !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-+=:,@%~", r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
}
