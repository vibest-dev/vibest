package chrome

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"
)

type WindowStates struct {
	Dir, Legacy string
}

const windowStateFile = "window-state.json"

func (s WindowStates) LoadWindowStates() (map[string]mygo.WindowState, error) {
	states, err := readStates(s.Dir)
	if !errors.Is(err, fs.ErrNotExist) {
		return states, err
	}
	if _, entryErr := os.Lstat(filepath.Join(s.Dir, windowStateFile)); !errors.Is(entryErr, fs.ErrNotExist) {
		return states, err
	}
	if s.Legacy == "" {
		return nil, nil
	}
	if states, err = readStates(s.Legacy); err != nil || len(states) == 0 {
		return nil, nil
	}
	s.SaveWindowStates(states)
	return states, nil
}

func (s WindowStates) SaveWindowStates(states map[string]mygo.WindowState) error {
	return writeConfig(s.Dir, windowStateFile, states)
}

func readStates(dir string) (map[string]mygo.WindowState, error) {
	data, err := os.ReadFile(filepath.Join(dir, windowStateFile))
	if err != nil {
		return nil, err
	}
	var states map[string]mygo.WindowState
	if err := json.Unmarshal(data, &states); err != nil {
		return nil, err
	}
	return states, nil
}
