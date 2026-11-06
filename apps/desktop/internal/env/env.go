package env

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var loginPath = sync.OnceValue(func() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, shell, "-l", "-c", `printf %s "$PATH"`).Output()
	if err != nil || len(out) == 0 {
		home, _ := os.UserHomeDir()
		return strings.Join([]string{filepath.Join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", os.Getenv("PATH")}, ":")
	}
	return string(out)
})

func FindHerdr() string {
	if p, err := exec.LookPath("herdr"); err == nil {
		return p
	}
	for _, dir := range filepath.SplitList(loginPath()) {
		p := filepath.Join(dir, "herdr")
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return "herdr"
}

func WithLoginPath(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, "PATH=") {
			out = append(out, kv)
		}
	}
	return append(out, "PATH="+loginPath())
}
