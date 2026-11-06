package herdr

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeSSH(t *testing.T, script string) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "ssh"), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

func TestDialSSHReportsSSH(t *testing.T) {
	fakeSSH(t, `echo "root@box: Permission denied (publickey)." >&2; exit 255`)
	_, err := DialSSH(context.Background(), "root@box", "default", Hello{Cols: 80, Rows: 24})
	if err == nil || !strings.Contains(err.Error(), "Permission denied (publickey)") {
		t.Fatalf("err = %v", err)
	}
}
