package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"github.com/egoist/mygo/ui"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"
	"vibest-desktop/internal/core"
)

func TestGitUsesActualCoreExecContract(t *testing.T) {
	a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
		f.exec = func(cwd string, argv []string) ([]byte, error) {
			if cwd != "/inert" || strings.Join(argv, "|") != "git|worktree|list|--porcelain|-z" {
				t.Error(cwd, argv)
			}
			return []byte("worktree /inert\x00\x00"), nil
		}
	})
	out, err := runCoreGit(context.Background(), a.coreSession, "/inert", []string{"worktree", "list", "--porcelain", "-z"})
	if err != nil || string(out) != "worktree /inert\x00\x00" {
		t.Fatal(string(out), err)
	}
	if len(coreRequests(f, "machine.exec")) != 1 {
		t.Fatal("not the Core contract")
	}
}
func TestCoreProgramImagesRenderWithBoundAndClipboardDenied(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	v := a.coreViews["a"]
	r := vtCell(t, tt, v, "a", 1, 1)
	src := image.NewNRGBA(image.Rect(0, 0, 2*r.Dx(), 2*r.Dy()))
	for i := range src.Pix {
		if i%4 == 1 || i%4 == 3 {
			src.Pix[i] = 255
		}
	}
	var pngBytes bytes.Buffer
	if e := png.Encode(&pngBytes, src); e != nil {
		t.Fatal(e)
	}
	data := base64.StdEncoding.EncodeToString(pngBytes.Bytes())
	v = coreOutput(t, a, f, tt, "a", "\x1b[2;2H\x1b_Ga=T,f=100,q=2,i=7;"+data+"\x1b\\")
	r = vtCell(t, tt, v, "a", 1, 1)
	if got := tt.Image().RGBAAt((r.Min.X+r.Max.X)/2, (r.Min.Y+r.Max.Y)/2); got != (color.RGBA{0, 255, 0, 255}) {
		t.Fatal("actual VT PNG not rendered", got)
	}
	opts := vtView(t, v).FieldByName("t").Elem().FieldByName("opts")
	if opts.FieldByName("ImageLimit").Int() != 16<<20 || !opts.FieldByName("NoClipboardWrite").Bool() || opts.FieldByName("ClipboardRead").Int() != 0 {
		t.Fatal("unbounded images or clipboard policy changed")
	}
	tt.SetClipboard("private clipboard")
	coreOutput(t, a, f, tt, "a", "\x1b]52;c;"+base64.StdEncoding.EncodeToString([]byte("program write"))+"\x07")
	if tt.Clipboard() != "private clipboard" {
		t.Fatal("program image path enabled clipboard writes")
	}
	coreOutput(t, a, f, tt, "a", "\x1b_Ga=d,d=I,i=7,q=2\x1b\\")
	r = vtCell(t, tt, v, "a", 1, 1)
	if got := tt.Image().RGBAAt((r.Min.X+r.Max.X)/2, (r.Min.Y+r.Max.Y)/2); nearColor(got, ui.RGB(0, 255, 0)) {
		t.Fatal("deleted image remained")
	}
	big := image.NewNRGBA(image.Rect(0, 0, 2049, 2049))
	for i := range big.Pix {
		if i%4 == 1 || i%4 == 3 {
			big.Pix[i] = 255
		}
	}
	pngBytes.Reset()
	if e := png.Encode(&pngBytes, big); e != nil {
		t.Fatal(e)
	}
	coreOutput(t, a, f, tt, "a", "\x1b[H\x1b_Ga=T,f=100,q=2,i=9;"+base64.StdEncoding.EncodeToString(pngBytes.Bytes())+"\x1b\\")
	r = vtCell(t, tt, v, "a", 0, 0)
	if got := tt.Image().RGBAAt((r.Min.X+r.Max.X)/2, (r.Min.Y+r.Max.Y)/2); nearColor(got, ui.RGB(0, 255, 0)) {
		t.Fatal("decoded image exceeded16MiB storage bound", got)
	}
	tt.Type("safe")
	wantCorePaneInput(t, f, "a", "safe")
	noCoreData(t, f)
}
func TestEditorExportsOriginalVTAndPositionsWithoutTerminalInput(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	a, f, tt := coreActivityUI(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[Horiginal scrollback\r\nsecond line")
	requests := make(chan editorRequest, 2)
	coreAppAct(a, func() {
		a.editor = func(ctx context.Context, r editorRequest) error {
			if !r.Current() {
				return core.ErrOwnership
			}
			requests <- r
			return nil
		}
		a.EditScrollback("a")
	})
	select {
	case r := <-requests:
		b, e := os.ReadFile(r.Path)
		if e != nil || !strings.Contains(string(b), "original scrollback") || r.Line != 0 {
			t.Fatal("wrong exported text/position", string(b), r, e)
		}
	case <-time.After(time.Second):
		t.Fatal("editor request absent")
	}
	coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[Hsrc/main.go:12:3")
	r := vtCell(t, tt, v, "a", 2, 0)
	var generation uint64
	coreAppAct(a, func() { generation = a.coreNavigation })
	tt.ClickAtWith(ui.Cmd, float32(r.Min.X+r.Max.X)/2, float32(r.Min.Y+r.Max.Y)/2)
	coreAppAct(a, func() {
		if a.coreNavigation != generation {
			t.Fatal("active-pane link click invalidated its own editor request")
		}
	})
	select {
	case request := <-requests:
		if request.Path != "/inert/repo/src/main.go" || request.Line != 12 || request.Column != 3 {
			t.Fatal("position lost", request)
		}
	case <-time.After(time.Second):
		t.Fatal("file position did not use editor")
	}
	for _, editor := range []string{"code", "/inert/bin/cursor", "zed", "nvim"} {
		args, e := editorArgv(editor, editorRequest{Path: "/inert/a file;$(no)", Line: 12, Column: 3})
		if e != nil || args[0] != editor {
			t.Fatal(args, e)
		}
		if strings.Contains(strings.Join(args, "|"), "sh|-c") {
			t.Fatal("editor used shell")
		}
	}
	noCoreData(t, f)
}
func TestEditorDelayedRequestRejectsReplacedProgram(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan bool, 1)
	coreAppAct(a, func() {
		a.editor = func(ctx context.Context, r editorRequest) error {
			close(entered)
			<-release
			current := r.Current()
			done <- current
			if !current {
				return core.ErrOwnership
			}
			return nil
		}
		a.EditScrollback("a")
	})
	<-entered
	f.mu.Lock()
	record := f.terminals["a"]
	f.mu.Unlock()
	f.report("restarted", record)
	awaitCoreApp(t, a, func() bool { return a.coreState.Programs["a"] > 0 })
	close(release)
	if <-done {
		t.Fatal("delayed editor rebound to replacement program")
	}
	noCoreData(t, f)
	_ = tt
}

func TestCoreGitRejectsUncertainOrUnboundedExecResults(t *testing.T) {
	zero, one := 0, 1
	for _, tc := range []struct {
		name             string
		code             *int
		out, stderr      string
		truncated, timed bool
	}{{"truncated", &zero, "", "", true, false}, {"timeout", &zero, "", "", false, true}, {"missing exit", nil, "", "", false, false}, {"bad base64", &zero, "?", "", false, false}, {"oversized", &zero, strings.Repeat("x", 350001), "", false, false}, {"dirty", &one, "", base64.StdEncoding.EncodeToString([]byte("dirty checkout")), false, false}} {
		t.Run(tc.name, func(t *testing.T) {
			a, f := newCoreAppFixtureWith(t, func(f *coreAppFixture) {
				f.execResult = map[string]any{"code": tc.code, "stdout": tc.out, "stderr": tc.stderr, "truncated": tc.truncated, "timed_out": tc.timed}
			})
			if _, e := runCoreGit(context.Background(), a.coreSession, "/inert", []string{"status"}); e == nil {
				t.Fatal("uncertain Git result accepted")
			}
			if len(coreRequests(f, "machine.exec")) != 1 || len(coreRequests(f, "terminal.run"))+len(coreRequests(f, "doc.set")) != 0 {
				t.Fatal("failed exec was retried or mutated topology")
			}
		})
	}
	a, f := newCoreAppFixture(t)
	for _, args := range [][]string{nil, {strings.Repeat("x", 16385)}, {"bad\x00arg"}} {
		if _, e := a.coreSession.ExecLocal(context.Background(), "/inert", args); e == nil {
			t.Fatal("unbounded argv accepted")
		}
	}
	if len(coreRequests(f, "machine.exec")) != 0 {
		t.Fatal("bad argv reached transport")
	}
}

func TestEditorPositionPreservesFileAuthorityAndLiteralArgv(t *testing.T) {
	for _, tc := range []struct {
		raw       string
		line, col int
	}{{"file://untrusted/a%20b:12:3", 12, 3}, {"file://untrusted/a:12", 12, 1}, {"file://untrusted/a", 0, 0}} {
		clean, line, col := coreFilePosition(tc.raw)
		if line != tc.line || col != tc.col {
			t.Fatal(clean, line, col)
		}
		if _, e := coreLinkURL(clean, "/inert", true); e == nil {
			t.Fatal("position parser stripped foreign file authority", clean)
		}
	}
	clean, line, col := coreFilePosition("file:///inert/a%20b:12:3")
	if clean != "file:///inert/a%20b" || line != 12 || col != 3 {
		t.Fatal(clean, line, col)
	}
}
