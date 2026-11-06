//go:build !e2e

package app

import (
	"fmt"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "herdr-mygo-state")
	if err == nil {
		err = os.Setenv("XDG_STATE_HOME", dir)
	}
	if err == nil {
		err = os.Setenv("VIBEST_HOME", dir)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
