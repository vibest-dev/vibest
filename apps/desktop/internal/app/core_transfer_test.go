package app

import (
	"bytes"
	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoreLocalClipboardFilesAndImagePaste(t *testing.T) {
	for _, eager := range []bool{false, true} {
		t.Run(map[bool]string{false: "lazy", true: "eager"}[eager], func(t *testing.T) { coreLocalClipboardFilesAndImagePaste(t, eager) })
	}
}

func coreLocalClipboardFilesAndImagePaste(t *testing.T, eager bool) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
	v := coreOutput(t, a, f, tt, "a", "\x1b[?2004h")
	tt.SetClipboardEager(eager)
	tt.SetClipboard("ordinary text")
	tt.Command("paste")
	wantCorePaneInput(t, f, "a", "\x1b[200~ordinary text\x1b[201~")
	files, err := transfer.FileData("/inert/a file", "/inert/it's")
	if err != nil {
		t.Fatal(err)
	}
	tt.SetClipboardData(files)
	tt.Command("paste")
	wantCorePaneInput(t, f, "a", "\x1b[200~"+shellEscape("/inert/a file")+" "+shellEscape("/inert/it's")+"\x1b[201~")
	var imageData bytes.Buffer
	if err := png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	tt.SetClipboardData(transfer.New(transfer.NewItem(transfer.Bytes(transfer.PNG, imageData.Bytes()))))
	tt.Command("paste")
	paths, err := filepath.Glob(filepath.Join(tmp, "herdr-paste-*.png"))
	if err != nil || len(paths) != 1 {
		t.Fatal("image paste did not create one owned file", paths, err)
	}
	body, err := os.ReadFile(paths[0])
	if err != nil || !bytes.Equal(body, imageData.Bytes()) {
		t.Fatal("local image bytes changed", err)
	}
	wantCorePaneInput(t, f, "a", "\x1b[200~"+shellEscape(paths[0])+"\x1b[201~")
	send := v.VT.CapturePaste()
	if send == nil {
		t.Fatal("missing original paste lease")
	}
	a.Focus(false)
	tt.SetFocused(false)
	a.Focus(true)
	tt.SetFocused(true)
	readyCorePane(t, a, tt, "a")
	send("stale after conversion")
	tt.Type("current")
	wantCorePaneInput(t, f, "a", "current")
	noCoreData(t, f)
}
func TestCoreLocalPasteRejectionDoesNotPoisonTyping(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	v := a.coreViews["a"]
	tt.SetClipboardData(transfer.New(transfer.NewItem(transfer.Bytes(transfer.URIList, []byte("file:///inert/bad%0Apath")))))
	tt.Command("paste")
	awaitCoreApp(t, a, func() bool { return strings.Contains(a.navigationNote, "control character") })
	noCoreData(t, f)
	coreAppAct(a, func() { a.askInWindow("Modal", "", false, func(string) {}) })
	tt.Frame()
	v.VT.Paste("modal refused")
	noCoreData(t, f)
	tt.Key(0, ui.KeyEscape)
	tt.SetClipboard("later")
	tt.Command("paste")
	wantCorePaneInput(t, f, "a", "later")
	noCoreData(t, f)
}
func TestCoreRemotePasteCannotCreateLocalImageOrSendPaths(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	a, f, tt := coreMachineUI(t)
	terminalWorkspace(t, tt, "Remote Alpha")
	wantRemoteNavigation(t, a, f, tt, "d")
	tt.SetClipboardData(transfer.New(transfer.NewItem(transfer.Bytes(transfer.PNG, []byte("never materialize")))))
	tt.Command("paste")
	paths, _ := filepath.Glob(filepath.Join(tmp, "herdr-paste-*.png"))
	if len(paths) != 0 {
		t.Fatal("remote refusal created a local image")
	}
	noCoreData(t, f)
}
func TestCoreLocalPathAndWebLinks(t *testing.T) {
	for _, tc := range []struct {
		raw, cwd, want string
		local          bool
	}{{"https://example.org/x", "", "https://example.org/x", false}, {"./src/main.go:12:3", "/inert/repo", "file:///inert/repo/src/main.go", true}, {"file:///inert/a%20b", "", "file:///inert/a%20b", true}, {"../a", "/inert/repo", "file:///inert/a", true}} {
		got, err := coreLinkURL(tc.raw, tc.cwd, tc.local)
		if err != nil || got != tc.want {
			t.Fatal("link", tc, got, err)
		}
	}
	for _, tc := range []struct {
		raw, cwd string
		local    bool
	}{{"javascript:alert(1)", "/inert", true}, {"file://elsewhere/a", "", true}, {"./a", "", true}, {"/inert/a", "/inert", false}, {"https://example.org/\n", "", true}} {
		if _, err := coreLinkURL(tc.raw, tc.cwd, tc.local); err == nil {
			t.Fatal("unsafe/unknown link accepted", tc)
		}
	}
	a, f, tt := coreShellFixture(t, 1280, 800, 1, false, "single")
	v := coreOutput(t, a, f, tt, "a", "\x1b[H\x1b]8;;file:///inert/local.txt\x07link\x1b]8;;\x07")
	r := vtCell(t, tt, v, "a", 1, 0)
	tt.ClickAtWith(ui.Cmd, float32(r.Min.X+r.Max.X)/2, float32(r.Min.Y+r.Max.Y)/2)
	tt.Frame()
	if got := tt.OpenedURLs(); len(got) != 1 || got[0] != "file:///inert/local.txt" {
		t.Fatal("real local link callback not opened", got)
	}
	noCoreData(t, f)
}

func TestCoreFailedGitWorktreeKeepsOldInputFenced(t *testing.T) {
	for _, kind := range []string{"create", "open"} {
		t.Run(kind, func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			v := a.coreViews["a"]
			g := &fakeGit{fail: "rev-parse", gate: make(chan struct{}), entered: make(chan struct{})}
			gate := g.gate
			coreAppAct(a, func() {
				a.gitExec = g.run
				if kind == "create" {
					a.CreateWorktree("w1", "branch")
				} else {
					a.OpenWorktree("w1", "/inert")
				}
			})
			tt.Frame()
			if v.InputReady() {
				t.Fatal("Git operation retained old native owner")
			}
			tt.Type("never send")
			<-g.entered
			close(gate)
			awaitCoreApp(t, a, func() bool { return a.coreOperationNote != "" && a.coreCapture == nil })
			if !a.coreBlocked || a.navigationNote != navigationLost {
				t.Fatal("failed Git did not explain unsent input", a.navigationNote)
			}
			coreAppAct(a, func() { a.ShowPane("a") })
			readyCorePane(t, a, tt, "a")
			tt.Type("later")
			wantCorePaneInput(t, f, "a", "later")
			if len(coreRequests(f, "terminal.run"))+len(coreRequests(f, "doc.set")) != 0 {
				t.Fatal("failed Git mutated topology or created a terminal")
			}
			noCoreData(t, f)
		})
	}
}
