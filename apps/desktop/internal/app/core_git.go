package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
	"vibest-desktop/internal/core"
)

type gitCommand func(context.Context, *core.Session, string, []string) ([]byte, error)
type repositoryInfo struct {
	root, common, branch   string
	linked, hasAheadBehind bool
	ahead, behind          int
	worktrees              []string
}

func runCoreGit(ctx context.Context, s *core.Session, cwd string, args []string) ([]byte, error) {
	return s.ExecLocal(ctx, cwd, append([]string{"git"}, args...))
}
func gitTextPath(path string) error {
	if !utf8.ValidString(path) || path == "" || len(path) > 4096 {
		return errors.New("empty, invalid or oversized Git path")
	}
	for _, r := range path {
		if r < 32 || r == 127 {
			return errors.New("Git path contains a control character")
		}
	}
	return nil
}
func inspectRepository(ctx context.Context, run gitCommand, s *core.Session, cwd string) (repositoryInfo, error) {
	var info repositoryInfo
	if !filepath.IsAbs(cwd) {
		return info, errors.New("workspace has no absolute local directory")
	}
	call := func(args ...string) (string, error) {
		b, e := run(ctx, s, cwd, args)
		if len(b) > 256<<10 {
			return "", errors.New("Git metadata exceeded256KiB")
		}
		return strings.TrimSuffix(string(b), "\n"), e
	}
	common, err := call("rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return info, err
	}
	root, err := call("rev-parse", "--show-toplevel")
	if err != nil {
		return info, err
	}
	if !filepath.IsAbs(common) || !filepath.IsAbs(root) || gitTextPath(common) != nil || gitTextPath(root) != nil {
		return info, errors.New("Git returned invalid repository identity")
	}
	info.root, info.common = filepath.Clean(root), filepath.Clean(common)
	list, err := call("worktree", "list", "--porcelain", "-z")
	if err != nil {
		return info, err
	}
	for _, field := range strings.Split(list, "\x00") {
		if p, ok := strings.CutPrefix(field, "worktree "); ok {
			if !filepath.IsAbs(p) || gitTextPath(p) != nil {
				return info, errors.New("Git returned invalid worktree path")
			}
			info.worktrees = append(info.worktrees, filepath.Clean(p))
			if len(info.worktrees) > 256 {
				return info, errors.New("too many worktrees")
			}
		}
	}
	if len(info.worktrees) == 0 {
		return info, errors.New("Git returned no worktree identity")
	}
	found := false
	for i, p := range info.worktrees {
		if p == info.root {
			found = true
			info.linked = i != 0
		}
	}
	if !found {
		return info, errors.New("working directory is not a listed checkout")
	}
	status, err := call("status", "--porcelain=v2", "--branch", "--untracked-files=no", "-z")
	if err != nil {
		return info, err
	}
	for _, field := range strings.Split(status, "\x00") {
		if branch, ok := strings.CutPrefix(field, "# branch.head "); ok && branch != "(detached)" {
			info.branch = branch
		}
		if ab, ok := strings.CutPrefix(field, "# branch.ab "); ok {
			info.hasAheadBehind = true
			parts := strings.Fields(ab)
			if len(parts) != 2 {
				return info, errors.New("invalid Git ahead/behind")
			}
			info.ahead, err = strconv.Atoi(strings.TrimPrefix(parts[0], "+"))
			if err != nil {
				return info, err
			}
			info.behind, err = strconv.Atoi(strings.TrimPrefix(parts[1], "-"))
			if err != nil || info.ahead < 0 || info.behind < 0 {
				return info, errors.New("invalid Git ahead/behind")
			}
		}
	}
	return info, nil
}
func createCheckout(ctx context.Context, run gitCommand, s *core.Session, base repositoryInfo, branch string) (string, error) {
	if gitTextPath(branch) != nil || strings.HasPrefix(branch, "-") {
		return "", errors.New("invalid branch name")
	}
	if _, err := run(ctx, s, base.root, []string{"check-ref-format", "--branch", branch}); err != nil {
		return "", err
	}
	b, err := run(ctx, s, base.root, []string{"branch", "--list", "--format=%(refname)", "--", branch})
	if err != nil {
		return "", err
	}
	path := filepath.Join(filepath.Dir(base.root), filepath.Base(base.root)+"-"+strings.ReplaceAll(branch, "/", "-"))
	args := []string{"worktree", "add"}
	if strings.TrimSpace(string(b)) == "" {
		args = append(args, "-b", branch)
	}
	args = append(args, "--", path)
	if strings.TrimSpace(string(b)) != "" {
		args = append(args, branch)
	}
	if _, err := run(ctx, s, base.root, args); err != nil {
		return "", fmt.Errorf("worktree add %s: %w; checkout may exist; not retried", path, err)
	}
	return path, nil
}
func applyRepository(w *core.Workspace, info repositoryInfo) {
	w.CWD, w.Repository, w.Linked = info.root, info.common, info.linked
	w.Branch = info.branch
	w.AheadBehind = nil
	if info.hasAheadBehind {
		w.AheadBehind = []int{info.ahead, info.behind}
	}
}
