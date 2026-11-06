//go:build integration

package herdr

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestDialSSH(t *testing.T) {
	if _, err := exec.LookPath("herdr"); err != nil {
		t.Skip("no herdr")
	}
	fakeSSH(t, `for a; do last=$a; done; eval "$last"`)
	for _, k := range []string{"HERDR_SESSION", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_ENV"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	const session = "mygo-ssh-test"
	t.Cleanup(func() {
		exec.Command("herdr", "session", "stop", session).Run()
		exec.Command("herdr", "session", "delete", session).Run()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	sh, err := DialSSH(ctx, "here", session, Hello{Cols: 80, Rows: 24, CellWidth: 8, CellHeight: 16})
	if err != nil {
		t.Fatal(err)
	}
	defer sh.Close()
	if sh.Version == "" {
		t.Fatal("no server version")
	}
}
