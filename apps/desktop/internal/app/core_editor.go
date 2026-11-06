package app

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/coreview"
)

type editorRequest struct {
	Path         string
	Line, Column int
	Current      func() bool
}
type editorOpen func(context.Context, editorRequest) error

func editorArgv(editor string, r editorRequest) ([]string, error) {
	if strings.TrimSpace(editor) == "" {
		if r.Line > 0 {
			return nil, errors.New("Set VISUAL or EDITOR to code, cursor, zed, or nvim for precise file positions")
		}
		return []string{"/usr/bin/open", "-t", r.Path}, nil
	}
	if strings.ContainsAny(editor, "\n\r\x00") || editor != strings.TrimSpace(editor) {
		return nil, errors.New("Editor must be one executable path, not a shell command")
	}
	base := filepath.Base(editor)
	line, col := max(1, r.Line), max(1, r.Column)
	switch base {
	case "code", "cursor":
		return []string{editor, "--goto", fmt.Sprintf("%s:%d:%d", r.Path, line, col)}, nil
	case "zed", "subl":
		return []string{editor, fmt.Sprintf("%s:%d:%d", r.Path, line, col)}, nil
	case "nvim", "vim", "vi":
		return []string{editor, fmt.Sprintf("+call cursor(%d,%d)", line, col), "--", r.Path}, nil
	}
	if r.Line > 0 {
		return nil, errors.New("Configured editor has no supported precise-position interface")
	}
	return []string{editor, r.Path}, nil
}
func defaultEditor(ctx context.Context, r editorRequest) error {
	editor := os.Getenv("VISUAL")
	if editor == "" {
		editor = os.Getenv("EDITOR")
	}
	args, err := editorArgv(editor, r)
	if err != nil {
		return err
	}
	if r.Current != nil && !r.Current() {
		return core.ErrOwnership
	}
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	return cmd.Run()
}
func (a *App) openEditorBound(id string, s *core.Session, ref core.TerminalRef, v *coreview.Terminal, r editorRequest, text *string) {
	program := a.coreState.Programs[ref.Address]
	intent, generation := a.coreNavigation, a.navigationGeneration
	valid := func() bool {
		return !a.windowClosed && a.coreSession == s && a.coreAttached[id] == ref && a.coreViews[id] == v && s.State().Programs[ref.Address] == program && a.coreNavigation == intent && a.navigationGeneration == generation && a.dialog == nil && a.nativeDialog == nil
	}
	r.Current = func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return valid()
	}
	open := a.editor
	if open == nil {
		open = func(ctx context.Context, r editorRequest) error {
			editor := os.Getenv("VISUAL")
			if editor == "" {
				editor = os.Getenv("EDITOR")
			}
			switch filepath.Base(editor) {
			case "vi", "vim", "nvim", "nano", "emacs":
				args, err := editorArgv(editor, r)
				if err != nil {
					return err
				}
				a.mu.Lock()
				defer a.mu.Unlock()
				if !valid() {
					return core.ErrOwnership
				}
				if ref.CoreID != a.coreState.Layout.CoreID {
					return errors.New("Remote scrollback cannot use a frontend-local editor file")
				}
				workspace, _ := a.coreState.Layout.Location(id)
				a.coreNavigation++
				next := a.coreNavigation
				n := a.beginCoreCapture("", true)
				a.corePending = true
				a.coreSelect(nil)
				a.coreRunCapture(s, next, n, core.TerminalRunParams{Argv: args}, "", func(l *core.Layout, p core.Pane, _ core.Terminal) error {
					_, err := l.AddTab(workspace, "Editor", p)
					return err
				})
				a.invalidate()
				return nil
			}
			return defaultEditor(ctx, r)
		}
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if text != nil {
			file, err := os.CreateTemp("", "vibest-desktop-scrollback-*.txt")
			if err != nil {
				a.coreNote(s, err.Error())
				return
			}
			r.Path = file.Name()
			_, err = file.WriteString(*text)
			if e := file.Close(); err == nil {
				err = e
			}
			if err != nil {
				os.Remove(r.Path)
				a.coreNote(s, err.Error())
				return
			}
		}
		a.mu.Lock()
		current := valid()
		a.mu.Unlock()
		if !current {
			if text != nil {
				os.Remove(r.Path)
			}
			return
		}
		if err := open(ctx, r); err != nil {
			if text != nil {
				os.Remove(r.Path)
			}
			if !errors.Is(err, core.ErrOwnership) {
				a.coreNote(s, "Editor not opened: "+err.Error())
			}
		}
	}()
}
func (a *App) coreEditScrollback(id string) {
	s, v := a.coreSession, a.coreViews[id]
	if s == nil || v == nil {
		a.coreUnavailable("Scrollback is not attached")
		return
	}
	text := v.VT.Text()
	if len(text) > 8<<20 {
		a.navigationNote = "Scrollback exceeds the 8 MiB export bound"
		a.invalidate()
		return
	}
	a.openEditorBound(id, s, a.coreAttached[id], v, editorRequest{}, &text)
}
func coreFilePosition(raw string) (string, int, int) {
	if u, e := url.Parse(raw); e == nil && (u.Scheme == "http" || u.Scheme == "https") {
		return raw, 0, 0
	}
	var fileURL *url.URL
	if u, err := url.Parse(raw); err == nil && u.Scheme == "file" {
		fileURL = u
		raw = u.Path
	}
	values := []int{}
	for range 2 {
		i := strings.LastIndexByte(raw, ':')
		if i < 0 {
			break
		}
		n, err := strconv.Atoi(raw[i+1:])
		if err != nil || n < 1 {
			break
		}
		values = append(values, n)
		raw = raw[:i]
	}
	if fileURL != nil {
		fileURL.Path = raw
		fileURL.RawPath = ""
		raw = fileURL.String()
	}
	if len(values) == 2 {
		return raw, values[1], values[0]
	}
	if len(values) == 1 {
		return raw, values[0], 1
	}
	return raw, 0, 0
}
