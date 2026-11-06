package core

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
)

func (s *Session) ExecLocal(ctx context.Context, cwd string, argv []string) ([]byte, error) {
	if !s.State().Connected {
		return nil, ErrClosed
	}
	if !slices.Contains(s.client.Hello().Methods, "machine.exec") {
		return nil, errors.New("Core does not advertise machine.exec")
	}
	if !filepath.IsAbs(cwd) || len(cwd) > 4096 || len(argv) == 0 || len(argv) > 32 {
		return nil, errors.New("exec needs a bounded absolute cwd and argv")
	}
	size := 0
	for _, arg := range argv {
		size += len(arg)
		if strings.ContainsRune(arg, 0) {
			return nil, errors.New("exec argument contains NUL")
		}
	}
	if size > 16<<10 {
		return nil, errors.New("exec argv exceeds 16KiB")
	}
	var r ExecResult
	timeout := 5.0
	err := s.client.Call(ctx, "machine.exec", MachineExecParams{CWD: &cwd, Argv: argv, Timeout: &timeout, Env: map[string]string{"GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}}, &r)
	if err != nil {
		return nil, err
	}
	if r.TimedOut || r.Truncated || len(r.Stdout) > 350000 || len(r.Stderr) > 350000 {
		return nil, errors.New("Git operation timed out or exceeded its output bound; result not retried")
	}
	out, err := base64.StdEncoding.DecodeString(r.Stdout)
	if err != nil {
		return nil, err
	}
	stderr, err := base64.StdEncoding.DecodeString(r.Stderr)
	if err != nil {
		return nil, err
	}
	if r.Code == nil || *r.Code != 0 {
		return nil, fmt.Errorf("Git refused: %s", strings.TrimSpace(string(stderr)))
	}
	return out, nil
}
