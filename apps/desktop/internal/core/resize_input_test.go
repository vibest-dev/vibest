package core_test

import (
	"context"
	"encoding/binary"
	"errors"
	"testing"
	"time"

	"vibest-desktop/internal/core"
)

func nextFrames(t *testing.T, f *fixture, n int) []packet {
	t.Helper()
	var out []packet
	for len(out) < n {
		select {
		case p := <-f.frames:
			out = append(out, p)
		case <-time.After(3 * time.Second):
			t.Fatalf("frames timed out after %v", out)
		}
	}
	return out
}

func TestTypingRightAfterAResizeReachesTheProgramAfterTheResize(t *testing.T) {
	c, f := newFixture(t)
	a := attach(t, c, f, "t1", 1)
	var keyboard core.Keyboard
	keyboard.Select(a)
	keyboard.Rendered(keyboard.OwnerKey(), 80, 24, 8, 16)
	typed, ok := keyboard.Capture()
	if !ok {
		t.Fatal("capture")
	}
	if err := a.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	keyboard.Rendered(keyboard.OwnerKey(), 120, 40, 8, 16)
	if _, err := typed.Write([]byte("x")); err != nil {
		t.Fatalf("a key typed before the resized paint was refused: %v", err)
	}
	keyboard.Rendered(keyboard.OwnerKey(), 120, 40, 9, 18)
	if _, err := typed.Write([]byte("y")); err != nil {
		t.Fatalf("a key typed before a cell size change was refused: %v", err)
	}
	got := nextFrames(t, f, 3)
	if got[0].kind != 3 || binary.LittleEndian.Uint16(got[0].body) != 120 || got[1].kind != 0 || string(got[1].body) != "x" || got[2].kind != 0 || string(got[2].body) != "y" {
		t.Fatalf("frames out of order: %v", got)
	}
}

func TestInputAfterARealOwnerChangeStillFails(t *testing.T) {
	c, f := newFixture(t)
	a := attach(t, c, f, "t1", 1)
	b := attach(t, c, f, "t2", 2)
	var keyboard core.Keyboard
	keyboard.Select(a)
	keyboard.Rendered(keyboard.OwnerKey(), 80, 24, 8, 16)
	typed, _ := keyboard.Capture()
	keyboard.Select(b)
	keyboard.Rendered(keyboard.OwnerKey(), 80, 24, 8, 16)
	if _, err := typed.Write([]byte("other viewer")); !errors.Is(err, core.ErrOwnership) {
		t.Fatalf("input crossed to another viewer: %v", err)
	}
	keyboard.Select(a)
	keyboard.Rendered(keyboard.OwnerKey(), 80, 24, 8, 16)
	typed, _ = keyboard.Capture()
	keyboard.Deselect(a)
	if _, err := typed.Write([]byte("no terminal")); !errors.Is(err, core.ErrOwnership) {
		t.Fatalf("input survived leaving the terminal: %v", err)
	}
	keyboard.Select(a)
	keyboard.Rendered(keyboard.OwnerKey(), 80, 24, 8, 16)
	typed, _ = keyboard.Capture()
	a.Close()
	if _, err := typed.Write([]byte("dead viewer")); err == nil {
		t.Fatal("input reached a closed viewer")
	}
}

func TestEmulatorRepliesUseAutomaticInputOnlyWhenTheCoreAndAttachSaySo(t *testing.T) {
	for _, tc := range []struct {
		name     string
		features []string
		attached bool
		kind     byte
	}{
		{"core and attach", []string{"automatic_input"}, true, 6},
		{"attach without the feature", nil, true, 0},
		{"feature without attach", []string{"automatic_input"}, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := newFixtureWithFeatures(t, nil, tc.features...)
			go func() {
				q := f.next()
				f.reply(q, map[string]any{"channel": 1, "automatic_input": tc.attached, "terminal": map[string]any{"address": "t1", "state": "live", "cols": 80, "rows": 24}})
			}()
			v, err := c.Attach(context.Background(), core.TerminalAttachParams{Terminal: "t1", Cols: 80, Rows: 24})
			if err != nil {
				t.Fatal(err)
			}
			var keyboard core.Keyboard
			keyboard.Select(v)
			keyboard.Rendered(keyboard.OwnerKey(), 80, 24, 8, 16)
			input, _ := keyboard.Capture()
			if _, err := input.WriteAutomatic([]byte("\x1b[48;24;80t")); err != nil {
				t.Fatal(err)
			}
			if _, err := input.Write([]byte("k")); err != nil {
				t.Fatal(err)
			}
			got := nextFrames(t, f, 2)
			if got[0].kind != tc.kind || string(got[0].body) != "\x1b[48;24;80t" || got[1].kind != 0 || string(got[1].body) != "k" {
				t.Fatalf("frames %v", got)
			}
		})
	}
}
