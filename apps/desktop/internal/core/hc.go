package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const CoreInstallCommand = "curl -fsSL https://releases.herdr.dev/core/install.sh | sh"

var ErrNoCore = errors.New("herdr-core is not installed")

type StartError struct{ Reason string }

func (e *StartError) Error() string { return "herdr-core is there but didn't start: " + e.Reason }

type Finder struct {
	Configured string
	Home       string
	Path       string
	Dirs       *string
	LoginPath  func() string
}

func FinderFromEnv(configured string) Finder {
	home, _ := os.UserHomeDir()
	f := Finder{Configured: configured, Home: home, Path: os.Getenv("PATH"), LoginPath: LoginShellPath}
	if dirs, ok := os.LookupEnv("HERDR_CORE_DIRS"); ok {
		f.Dirs = &dirs
	}
	return f
}

func (f Finder) Find() (string, error) {
	pick := func(candidates []string) string {
		for _, c := range candidates {
			if st, err := os.Stat(c); err == nil && st.Mode().IsRegular() && IsHC(c) {
				return c
			}
		}
		return ""
	}
	if f.Configured != "" {
		if found := pick([]string{expandHome(f.Configured, f.Home)}); found != "" {
			return found, nil
		}
	}
	if f.Dirs != nil {
		if found := pick(names(filepath.SplitList(*f.Dirs))); found != "" {
			return found, nil
		}
		return "", ErrNoCore
	}
	if found := pick(names(append(filepath.SplitList(f.Path), usualDirs(f.Home)...))); found != "" {
		return found, nil
	}
	if f.LoginPath != nil {
		if found := pick(names(filepath.SplitList(f.LoginPath()))); found != "" {
			return found, nil
		}
	}
	return "", ErrNoCore
}

func IsHC(bin string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	return err == nil && strings.HasPrefix(strings.TrimSpace(string(out)), "hc ")
}

func expandHome(p, home string) string {
	if rest, ok := strings.CutPrefix(p, "~/"); ok {
		return filepath.Join(home, rest)
	}
	return p
}

func names(dirs []string) []string {
	var out []string
	for _, d := range dirs {
		if d != "" {
			out = append(out, filepath.Join(d, "herdr-core"), filepath.Join(d, "hc"))
		}
	}
	return out
}

func usualDirs(home string) []string {
	dirs := []string{
		filepath.Join(home, ".local/bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		filepath.Join(home, ".local/share/mise/shims"),
		filepath.Join(home, ".nix-profile/bin"),
		"/run/current-system/sw/bin",
		filepath.Join(home, ".cargo/bin"),
	}
	if runtime.GOOS == "darwin" {
		dirs = append(dirs, filepath.Join(home, ".local/share/herdr-core/current/Contents/MacOS"), filepath.Join(home, ".local/share/herdr-core/Herdr Core.app/Contents/MacOS"))
	}
	return dirs
}

func LoginShellPath() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, shell, "-lc", `printf %s "$PATH"`).Output()
	if err != nil {
		return ""
	}
	return string(out)
}

func FillPathFromLoginShell() {
	if runtime.GOOS != "darwin" || os.Getppid() != 1 {
		return
	}
	home, _ := os.UserHomeDir()
	dirs := filepath.SplitList(LoginShellPath())
	dirs = append(dirs, usualDirs(home)[:3]...)
	dirs = append(dirs, filepath.SplitList(os.Getenv("PATH"))...)
	seen := map[string]bool{}
	var kept []string
	for _, d := range dirs {
		if d != "" && !seen[d] {
			seen[d] = true
			kept = append(kept, d)
		}
	}
	os.Setenv("PATH", strings.Join(kept, string(filepath.ListSeparator)))
}

type HC struct {
	Finder  Finder
	Session string
	Socket  string
}

func (h HC) Dial(ctx context.Context, _ string) (*Client, error) {
	bin, err := h.Finder.Find()
	if err != nil {
		return nil, err
	}
	return h.connect(ctx, bin)
}

func (h HC) connect(ctx context.Context, bin string) (*Client, error) {
	toCore, childIn, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	childOut, fromCore, err := os.Pipe()
	if err != nil {
		toCore.Close()
		childIn.Close()
		return nil, err
	}
	cmd := exec.Command(bin, "connect")
	cmd.Env = os.Environ()
	if h.Session != "" {
		cmd.Env = append(cmd.Env, "HC_SESSION="+h.Session)
	}
	if h.Socket != "" {
		cmd.Env = append(cmd.Env, "HC_SOCKET="+h.Socket)
	}
	cmd.Stdin, cmd.Stdout = toCore, fromCore
	stderr := &tail{max: 4096}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		for _, f := range []*os.File{toCore, childIn, childOut, fromCore} {
			f.Close()
		}
		return nil, &StartError{Reason: err.Error()}
	}
	toCore.Close()
	fromCore.Close()
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	conn := &processConn{in: childIn, out: childOut, cmd: cmd, exited: exited}
	c, err := connect(ctx, conn, 15*time.Second)
	if err != nil {
		var mismatch *Mismatch
		if errors.As(err, &mismatch) {
			return nil, err
		}
		select {
		case <-exited:
		case <-time.After(time.Second):
		}
		if reason := strings.TrimSpace(stderr.String()); reason != "" {
			return nil, &StartError{Reason: reason}
		}
		return nil, &StartError{Reason: err.Error()}
	}
	return c, nil
}

type tail struct {
	mu  sync.Mutex
	max int
	buf bytes.Buffer
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf.Write(p)
	if extra := t.buf.Len() - t.max; extra > 0 {
		t.buf.Next(extra)
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.buf.String()
}

type processConn struct {
	in     *os.File
	out    *os.File
	cmd    *exec.Cmd
	exited chan struct{}
	once   sync.Once
}

func (c *processConn) Read(p []byte) (int, error)  { return c.out.Read(p) }
func (c *processConn) Write(p []byte) (int, error) { return c.in.Write(p) }
func (c *processConn) Close() error {
	c.once.Do(func() {
		c.in.Close()
		c.out.Close()
		go func() {
			select {
			case <-c.exited:
			case <-time.After(2 * time.Second):
				c.cmd.Process.Kill()
			}
		}()
	})
	return nil
}
func (c *processConn) LocalAddr() net.Addr  { return processAddr(c.cmd.Path) }
func (c *processConn) RemoteAddr() net.Addr { return processAddr(c.cmd.Path) }
func (c *processConn) SetDeadline(t time.Time) error {
	return errors.Join(c.in.SetDeadline(t), c.out.SetDeadline(t))
}
func (c *processConn) SetReadDeadline(t time.Time) error  { return c.out.SetReadDeadline(t) }
func (c *processConn) SetWriteDeadline(t time.Time) error { return c.in.SetWriteDeadline(t) }

type processAddr string

func (a processAddr) Network() string { return "hc connect" }
func (a processAddr) String() string  { return fmt.Sprintf("%s connect", string(a)) }
