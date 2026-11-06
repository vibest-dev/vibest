package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"vibest-desktop/internal/core"
)

type fakeGit struct {
	mu    sync.Mutex
	calls []struct {
		cwd  string
		args []string
	}
	fail    string
	gate    chan struct{}
	entered chan struct{}
}

func (f *fakeGit) run(ctx context.Context, s *core.Session, cwd string, args []string) ([]byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, struct {
		cwd  string
		args []string
	}{cwd, append([]string(nil), args...)})
	fail := f.fail
	gate, entered := f.gate, f.entered
	if gate != nil {
		f.gate = nil
	}
	f.mu.Unlock()
	if gate != nil {
		close(entered)
		select {
		case <-gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	key := strings.Join(args, " ")
	if fail != "" && strings.Contains(key, fail) {
		return nil, errors.New("fake Git refused dirty/locked worktree")
	}
	switch args[0] {
	case "rev-parse":
		if args[len(args)-1] == "--git-common-dir" {
			return []byte("/inert/repo/.git\n"), nil
		}
		return []byte(cwd + "\n"), nil
	case "worktree":
		if args[1] == "list" {
			return []byte("worktree /inert/repo\x00\x00worktree /inert/other\x00\x00worktree /inert/repo-branch\x00\x00"), nil
		}
		return nil, nil
	case "status":
		return []byte("# branch.head branch\x00# branch.ab +2 -3\x00"), nil
	case "check-ref-format", "branch":
		return nil, nil
	}
	return nil, fmt.Errorf("unexpected Git argv%v", args)
}
func TestGitCommandsAreBoundedArgvAndNeverForced(t *testing.T) {
	g := &fakeGit{}
	info, e := inspectRepository(context.Background(), g.run, nil, "/inert/repo")
	if e != nil || info.branch != "branch" || info.ahead != 2 || info.behind != 3 {
		t.Fatal(info, e)
	}
	p, e := createCheckout(context.Background(), g.run, nil, info, "feature/quoted;$(never)")
	if e != nil || p != "/inert/repo-feature-quoted;$(never)" {
		t.Fatal(p, e)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, c := range g.calls {
		for _, v := range c.args {
			if v == "sh" || v == "-c" || v == "--force" || v == "-f" {
				t.Fatal("shell/force argument", c)
			}
		}
	}
	last := g.calls[len(g.calls)-1]
	if strings.Join(last.args, "|") != "worktree|add|-b|feature/quoted;$(never)|--|/inert/repo-feature-quoted;$(never)" {
		t.Fatal("branch interpolated instead of passed literally", last)
	}
}
