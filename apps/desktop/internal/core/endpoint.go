package core

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
)

type EndpointOptions struct {
	Session, Socket, ConfigSocket string
	Home, StateHome, RuntimeDir   string
	UID                           int
	RunUserExists                 bool
}

func (o EndpointOptions) Path() (string, error) {
	session := strings.TrimSpace(o.Session)
	if session == "" {
		session = "default"
	}
	if session == "." || session == ".." || strings.ContainsAny(session, "/\\:*?\"<>|") || strings.ContainsFunc(session, unicode.IsControl) {
		return "", errors.New("core: invalid HC_SESSION")
	}
	state := o.StateHome
	if state == "" {
		state = filepath.Join(o.Home, ".local", "state")
	}
	state = filepath.Join(state, "herdr-core", session)
	run := o.RuntimeDir
	if run == "" && o.RunUserExists {
		run = fmt.Sprintf("/run/user/%d", o.UID)
	}
	if run != "" {
		state = filepath.Join(run, "herdr-core")
	}
	socket := o.Socket
	if socket == "" {
		socket = o.ConfigSocket
	}
	if socket == "" {
		socket = filepath.Join(state, session+".sock")
	}
	if !filepath.IsAbs(socket) {
		return "", errors.New("core: use an absolute socket path")
	}
	max := 107
	if runtime.GOOS == "darwin" {
		max = 103
	}
	holder := strings.TrimSuffix(socket, filepath.Ext(socket)) + ".holder.sock"
	if len(socket) > max || len(holder)+9 > max {
		return "", errors.New("core: socket path leaves insufficient room for holder endpoints")
	}
	return socket, nil
}

func EndpointFromEnv(session, explicit string) (string, error) {
	if runtime.GOOS == "windows" {
		return "", errors.New("core: this client currently supports Unix sockets only")
	}
	if session == "" {
		session = os.Getenv("HC_SESSION")
	}
	if explicit == "" {
		explicit = os.Getenv("HC_SOCKET")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if explicit == "" {
		config := os.Getenv("XDG_CONFIG_HOME")
		if config == "" {
			config = filepath.Join(home, ".config")
		}
		_, err := os.Stat(filepath.Join(config, "herdr-core", "config.toml"))
		if err == nil {
			return "", errors.New("core: config.toml exists; specify -core-socket or HC_SOCKET explicitly")
		}
		if !os.IsNotExist(err) {
			return "", err
		}
	}
	uid := os.Getuid()
	st, err := os.Stat(fmt.Sprintf("/run/user/%d", uid))
	return (EndpointOptions{Session: session, Socket: explicit, Home: home, StateHome: os.Getenv("XDG_STATE_HOME"), RuntimeDir: os.Getenv("XDG_RUNTIME_DIR"), UID: uid, RunUserExists: err == nil && st.IsDir()}).Path()
}

func Dial(ctx context.Context, socket string) (*Client, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, err
	}
	return Connect(ctx, conn)
}
