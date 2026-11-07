//go:build e2edebug

package app

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
)

func StartDebug(app *App, win *mygo.Window) {
	if os.Getenv("VIBEST_DESKTOP_DEBUG") != "1" {
		return
	}
	path := os.Getenv("VIBEST_DESKTOP_DEBUG_SOCKET")
	if path == "" {
		path = filepath.Join(os.TempDir(), fmt.Sprintf("vibest-desktop-%d.sock", os.Getpid()))
	}
	os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		log.Println("debug socket:", err)
		return
	}
	os.Chmod(path, 0o600)
	win.OnClosed(func() { ln.Close(); os.Remove(path) })
	log.Println("debug socket:", path)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				sc := bufio.NewScanner(conn)
				for sc.Scan() {
					cmd, arg, _ := strings.Cut(strings.TrimSpace(sc.Text()), " ")
					switch cmd {
					case "state":
						json.NewEncoder(conn).Encode(app.State())
					case "notification-click":
						win.Focus()
						app.ShowNotice(arg)
						fmt.Fprintln(conn, `{"ok":true}`)
					default:
						fmt.Fprintln(conn, `{"error":"unknown command"}`)
					}
				}
			}()
		}
	}()
}
