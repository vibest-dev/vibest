package core_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibest-desktop/internal/core"
)

const fakeHC = `#!/bin/sh
case "$1" in
--version) echo "hc 0.1.18" ;;
connect)
	if [ -n "$FAKE_HC_FAIL" ]; then
		echo "$FAKE_HC_FAIL" >&2
		exit 1
	fi
	if [ ! -S "$HC_SOCKET" ]; then
		touch "$FAKE_HC_DIR/started"
		i=0
		while [ ! -S "$HC_SOCKET" ] && [ $i -lt 200 ]; do sleep 0.02; i=$((i + 1)); done
	fi
	exec nc -U "$HC_SOCKET"
	;;
esac
`

func fakeHCDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "vdhc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if err := os.WriteFile(filepath.Join(dir, "hc"), []byte(fakeHC), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_HC_DIR", dir)
	return dir
}

func fakeCore(t *testing.T, socket string, hello map[string]any) {
	t.Helper()
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				r := bufio.NewReader(conn)
				line, err := r.ReadBytes('\n')
				if err != nil {
					return
				}
				var q struct {
					ID uint64 `json:"id"`
				}
				json.Unmarshal(line, &q)
				out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": q.ID, "result": hello})
				conn.Write(append(out, '\n'))
				r.WriteTo(&discard{})
			}()
		}
	}()
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

func servingHello(generation uint32) map[string]any {
	return map[string]any{
		"generation": generation, "version": "0.1.18", "framed": true, "core": map[string]string{"id": "fake", "name": "fake"},
		"methods":  []string{"terminal.run", "terminal.get", "terminal.attach", "terminal.kill", "events.subscribe", "doc.get", "doc.set", "machine.list"},
		"features": []string{"framed", "attach", "events", "status", "shell"},
	}
}

func hcIn(dir string) core.HC {
	return core.HC{Finder: core.Finder{Dirs: &dir}, Socket: filepath.Join(dir, "hc.sock")}
}

func TestFindingHerdrCoreSkipsWhatIsNotHC(t *testing.T) {
	empty := t.TempDir()
	if _, err := (core.Finder{Dirs: &empty}).Find(); !errors.Is(err, core.ErrNoCore) {
		t.Fatalf("no hc: %v", err)
	}
	other := t.TempDir()
	os.WriteFile(filepath.Join(other, "hc"), []byte("#!/bin/sh\necho 'herbstclient 0.9'\n"), 0o755)
	if _, err := (core.Finder{Dirs: &other}).Find(); !errors.Is(err, core.ErrNoCore) {
		t.Fatalf("an unrelated hc was taken: %v", err)
	}
	dir := fakeHCDir(t)
	if got, err := (core.Finder{Path: other + ":" + dir, Home: empty}).Find(); err != nil || got != filepath.Join(dir, "hc") {
		t.Fatalf("PATH: %q %v", got, err)
	}
	if got, err := (core.Finder{Configured: filepath.Join(dir, "hc"), Dirs: &empty}).Find(); err != nil || got != filepath.Join(dir, "hc") {
		t.Fatalf("configured: %q %v", got, err)
	}
	login := func() string { return dir }
	if got, err := (core.Finder{Path: other, Home: empty, LoginPath: login}).Find(); err != nil || got != filepath.Join(dir, "hc") {
		t.Fatalf("login shell PATH: %q %v", got, err)
	}
}

func TestDialWithoutHerdrCoreSaysItIsNotInstalled(t *testing.T) {
	empty := t.TempDir()
	if _, err := hcIn(empty).Dial(context.Background(), ""); !errors.Is(err, core.ErrNoCore) {
		t.Fatalf("got %v", err)
	}
}

func TestDialConnectsToARunningCoreThroughHCConnect(t *testing.T) {
	dir := fakeHCDir(t)
	h := hcIn(dir)
	fakeCore(t, h.Socket, servingHello(core.PinnedGeneration))
	c, err := h.Dial(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if c.Hello().Core.ID != "fake" {
		t.Fatalf("hello %+v", c.Hello())
	}
	if _, err := os.Stat(filepath.Join(dir, "started")); err == nil {
		t.Fatal("hc connect started a core that was running")
	}
}

func TestDialStartsACoreThatIsNotRunning(t *testing.T) {
	dir := fakeHCDir(t)
	h := hcIn(dir)
	go func() {
		for i := 0; i < 500; i++ {
			if _, err := os.Stat(filepath.Join(dir, "started")); err == nil {
				fakeCore(t, h.Socket, servingHello(core.PinnedGeneration))
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	c, err := h.Dial(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := os.Stat(filepath.Join(dir, "started")); err != nil {
		t.Fatal("hc connect was not asked to start the core")
	}
}

func TestDialReportsWhyHCConnectCouldNotStartTheCore(t *testing.T) {
	dir := fakeHCDir(t)
	t.Setenv("FAKE_HC_FAIL", "error: core did not start within 5 s")
	_, err := hcIn(dir).Dial(context.Background(), "")
	var start *core.StartError
	if !errors.As(err, &start) || !strings.Contains(err.Error(), "herdr-core is there but didn't start: error: core did not start within 5 s") {
		t.Fatalf("got %v", err)
	}
}

func TestDialRefusesACoreOfAnotherGenerationOrMissingMethods(t *testing.T) {
	for _, tc := range []struct {
		name   string
		hello  map[string]any
		tooOld bool
	}{
		{"newer generation", servingHello(core.PinnedGeneration + 1), false},
		{"missing methods", map[string]any{"generation": core.PinnedGeneration, "version": "0.1.9", "framed": true, "core": map[string]string{"id": "fake"}, "methods": []string{}, "features": []string{}}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := fakeHCDir(t)
			h := hcIn(dir)
			fakeCore(t, h.Socket, tc.hello)
			_, err := h.Dial(context.Background(), "")
			var mismatch *core.Mismatch
			if !errors.As(err, &mismatch) || mismatch.CoreTooOld() != tc.tooOld || mismatch.CoreTooNew() == tc.tooOld {
				t.Fatalf("got %v", err)
			}
		})
	}
}
