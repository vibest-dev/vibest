package herdr

import (
	"os"
	"path/filepath"
	"strings"
)

func SocketPath(session string) string {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".config", "herdr")
	if session == "" || session == "default" {
		return filepath.Join(dir, "herdr.sock")
	}
	return filepath.Join(dir, "sessions", session, "herdr.sock")
}

func CommandEnv(socket string) []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "HERDR_") && !strings.HasPrefix(kv, "HERDR_CONFIG_PATH=") {
			continue
		}
		env = append(env, kv)
	}
	if socket != "" {
		env = append(env, "HERDR_SOCKET_PATH="+socket)
	}
	return env
}
