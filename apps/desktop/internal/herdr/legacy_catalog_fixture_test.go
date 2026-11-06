package herdr

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type Machine struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Target  string `json:"target"`
	Session string `json:"session"`
	Enabled bool   `json:"enabled"`
}

func catalogDir() string {
	dir := os.Getenv("XDG_STATE_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(dir, "herdr", "client")
}

func Machines() ([]Machine, error) {
	b, err := os.ReadFile(filepath.Join(catalogDir(), "endpoints.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var c struct {
		Version int       `json:"version"`
		SSH     []Machine `json:"ssh"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, errors.New("herdr: unreadable saved machines")
	}
	if c.Version != 1 {
		return nil, errors.New("herdr: saved machines of an unknown version")
	}
	return c.SSH, nil
}

func SelectedMachine() string {
	b, err := os.ReadFile(filepath.Join(catalogDir(), "endpoint-selection.json"))
	if err != nil {
		return ""
	}
	var s struct {
		Selected *string `json:"selected_profile"`
	}
	if json.Unmarshal(b, &s) != nil || s.Selected == nil {
		return ""
	}
	return *s.Selected
}

func SelectMachine(id string) error {
	var sel any
	if id != "" {
		sel = id
	}
	b, _ := json.MarshalIndent(map[string]any{"version": 1, "selected_profile": sel}, "", "  ")
	dir := catalogDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, "endpoint-selection.json")
	f, err := os.CreateTemp(dir, ".endpoint-selection-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
