package herdr

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

func DialSSH(ctx context.Context, target, session string, h Hello) (*Shell, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	ours, theirs := os.NewFile(uintptr(fds[0]), "herdr"), os.NewFile(uintptr(fds[1]), "ssh")
	defer theirs.Close()
	conn, err := net.FileConn(ours)
	ours.Close()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command("ssh", "-T", "-C",
		"-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
		"-o", "ControlMaster=no", "-o", "ClearAllForwardings=yes",
		"--", target, "/bin/sh -c "+quote(bridgeScript(session)))
	var stderr bytes.Buffer
	cmd.Stdin, cmd.Stdout, cmd.Stderr = theirs, theirs, &stderr
	if err := cmd.Start(); err != nil {
		conn.Close()
		return nil, err
	}
	exited := make(chan struct{})
	go func() {
		cmd.Wait()
		conn.Close()
		close(exited)
	}()
	sh, err := handshake(ctx, conn, h, 30*time.Second)
	if err != nil {
		cmd.Process.Kill()
		<-exited
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			lines := strings.Split(msg, "\n")
			return nil, fmt.Errorf("ssh %s: %s", target, lines[len(lines)-1])
		}
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return nil, fmt.Errorf("ssh %s: no answer", target)
		}
		return nil, err
	}
	return sh, nil
}

func bridgeScript(session string) string {
	return `for p in "$(command -v herdr)" "$HOME/.local/bin/herdr" /usr/local/bin/herdr /opt/homebrew/bin/herdr /home/linuxbrew/.linuxbrew/bin/herdr "$HOME/.nix-profile/bin/herdr"; do
	[ -x "$p" ] && exec "$p" --session ` + quote(session) + ` remote-client-bridge
done
echo "herdr not found on $(hostname)" >&2
exit 127`
}

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
