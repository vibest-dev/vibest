package app

import (
	"bytes"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"unsafe"

	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
)

//go:linkname fileDrop github.com/egoist/mygo/ui.(*engine).fileDrop
func fileDrop(rt unsafe.Pointer, x, y float32, files []string) bool

func testerEngine(tt *ui.Tester) unsafe.Pointer {
	rt := reflect.ValueOf(tt).Elem().FieldByName("rt")
	return reflect.NewAt(rt.Type(), unsafe.Pointer(rt.UnsafeAddr())).Elem().UnsafePointer()
}

func TestClipboardPaths(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		if p, err := clipboardPaths(transfer.Data{}); len(p) != 0 || err != nil {
			t.Fatalf("got %q, %v", p, err)
		}
	})
	t.Run("files", func(t *testing.T) {
		d := transfer.New(
			transfer.NewItem(transfer.Bytes(transfer.URIList, []byte("file:///tmp/a%20b.txt\r\n"))),
			transfer.NewItem(transfer.Bytes(transfer.URIList, []byte("file:///tmp/c.txt\r\n"))),
		)
		p, err := clipboardPaths(d)
		if err != nil || !reflect.DeepEqual(p, []string{"/tmp/a b.txt", "/tmp/c.txt"}) {
			t.Fatalf("got %q, %v", p, err)
		}
		if got, err := quotePaths(p, quoteBackslash); err != nil || got != `/tmp/a\ b.txt /tmp/c.txt` {
			t.Fatalf("got %q %v", got, err)
		}
	})
	t.Run("image", func(t *testing.T) {
		dir := t.TempDir() + "/with space"
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("TMPDIR", dir)
		png := append([]byte("\x89PNG\r\n\x1a\n"), "rest"...)
		p, err := clipboardPaths(transfer.New(transfer.NewItem(transfer.Bytes(transfer.PNG, png))))
		if err != nil || len(p) != 1 {
			t.Fatalf("got %q, %v", p, err)
		}
		if b, _ := os.ReadFile(p[0]); !bytes.Equal(b, png) {
			t.Fatalf("file %s holds %q", p[0], b)
		}
		got, err := quotePaths(p, quoteBackslash)
		if err != nil || !strings.Contains(got, `with\ space`) {
			t.Fatalf("image path not escaped: %q %v", got, err)
		}
	})
}

func TestQuotePaths(t *testing.T) {
	got, err := quotePaths([]string{"/tmp/my file"}, quotePOSIX)
	if err != nil || got != "'/tmp/my file'" {
		t.Fatalf("space: %q %v", got, err)
	}
	if back, err := quotePaths([]string{"/tmp/my file"}, quoteBackslash); err != nil || back != `/tmp/my\ file` {
		t.Fatalf("backslash: %q %v", back, err)
	}
	got, err = quotePaths([]string{"it's"}, quotePOSIX)
	if err != nil || got != `'it'\''s'` {
		t.Fatalf("quote: %q %v", got, err)
	}
	got, err = quotePaths([]string{"/tmp/中文.txt"}, quotePOSIX)
	if err != nil || got != "'/tmp/中文.txt'" {
		t.Fatalf("text: %q %v", got, err)
	}
	got, err = quotePaths([]string{"/a", "/b"}, quotePOSIX)
	if err != nil || got != "'/a' '/b'" || strings.Contains(got, "\n") {
		t.Fatalf("two paths: %q %v", got, err)
	}
	if got, err := quotePaths(nil, quotePOSIX); err != nil || got != "" {
		t.Fatalf("empty: %q %v", got, err)
	}
	if _, err := quotePaths([]string{"a\nb"}, quotePOSIX); !errors.Is(err, errPasteControl) {
		t.Fatalf("newline: %v", err)
	}
	if _, err := quotePaths([]string{"ok", "\x7f"}, quoteBackslash); !errors.Is(err, errPasteControl) {
		t.Fatalf("del: %v", err)
	}
	if _, err := quotePaths([]string{"fine", string([]byte{0xff})}, quotePOSIX); !errors.Is(err, errPastePath) {
		t.Fatalf("bytes: %v", err)
	}
	many := make([]string, maxPastePaths+1)
	for i := range many {
		many[i] = "a"
	}
	if _, err := quotePaths(many, quotePOSIX); !errors.Is(err, errPasteTooMany) {
		t.Fatalf("count: %v", err)
	}
	long := strings.Repeat("a", maxPasteBytes)
	if _, err := quotePaths([]string{long}, quotePOSIX); !errors.Is(err, errPasteTooLong) {
		t.Fatalf("long: %v", err)
	}
	fit := strings.Repeat("b", maxPasteBytes-2)
	got, err = quotePaths([]string{fit}, quotePOSIX)
	if err != nil || len(got) != maxPasteBytes || strings.Contains(got, "\n") {
		t.Fatalf("fit: len %d %v", len(got), err)
	}
}

func TestDroppedFilePaste(t *testing.T) {
	a, f, tt := coreShellFixture(t, 800, 500, 1, false, "single")
	v := coreOutput(t, a, f, tt, "a", "\x1b[?2004h")
	r := vtCell(t, tt, v, "a", 1, 1)
	drop := func(paths []string) bool {
		return fileDrop(testerEngine(tt), float32(r.Min.X+r.Max.X)/2, float32(r.Min.Y+r.Max.Y)/2, paths)
	}
	if !drop([]string{"/tmp/my file", "it's"}) {
		t.Fatal("terminal did not take file drop")
	}
	tt.Frame()
	wantCorePaneInput(t, f, "a", "\x1b[200~"+`'/tmp/my file' 'it'\''s'`+"\x1b[201~")
	tt.Frame()
	noCoreData(t, f)
	coreAppAct(a, func() { a.askInWindow("Popup", "", false, func(string) {}) })
	tt.Frame()
	drop([]string{"/tmp/refused"})
	tt.Frame()
	noCoreData(t, f)
	tt.Key(0, ui.KeyEscape)
	readyCorePane(t, a, tt, "a")
	if !drop([]string{"/tmp/valid", "bad\npath"}) {
		t.Fatal("invalid drop not consumed")
	}
	tt.Frame()
	awaitCoreApp(t, a, func() bool { return strings.Contains(a.navigationNote, "control character") })
	tt.Frame()
	noCoreData(t, f)
	if !tt.HasText("A file path contains a control character") {
		t.Fatal("path refusal not visible", tt.Texts())
	}
	if !drop([]string{"/tmp/later"}) {
		t.Fatal("valid drop after refusal failed")
	}
	tt.Frame()
	wantCorePaneInput(t, f, "a", "\x1b[200~'/tmp/later'\x1b[201~")
	noCoreData(t, f)
}

func TestFileDropZonesBuild(t *testing.T) {
	a, f, tt := coreShellFixture(t, 800, 500, 1, false, "single")
	v := coreOutput(t, a, f, tt, "a", "\x1b[Hselect these words")
	start, end := vtCell(t, tt, v, "a", 0, 0), vtCell(t, tt, v, "a", 5, 0)
	tt.Press(float32(start.Min.X+1), float32(start.Min.Y+start.Dy()/2))
	tt.Move(float32(end.Max.X-1), float32(end.Min.Y+end.Dy()/2))
	tt.Release(float32(end.Max.X-1), float32(end.Min.Y+end.Dy()/2))
	tt.Command("copy")
	if !strings.HasPrefix(tt.Clipboard(), "select") {
		t.Fatal("file-drop zone took terminal selection", tt.Clipboard())
	}
	head := find(t, tt, "pane-header/a")
	if fileDrop(testerEngine(tt), head.X+10, head.Y+10, []string{"/tmp/no"}) {
		t.Fatal("header registered as terminal drop zone")
	}
	noCoreData(t, f)
}

func TestShellEscape(t *testing.T) {
	if got, want := shellEscape("/a b/(c)'d.png"), `/a\ b/\(c\)\'d.png`; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
