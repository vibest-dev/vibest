package chrome

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type Settings struct {
	Theme         string  `json:"theme"`
	ThemeDark     string  `json:"theme_dark"`
	FollowSystem  bool    `json:"follow_system"`
	SidebarHidden bool    `json:"sidebar_hidden,omitempty"`
	SidebarWidth  float32 `json:"sidebar_width,omitempty"`
	PaneStyle     string  `json:"pane_style,omitempty"`
	Translucent   bool    `json:"translucent,omitempty"`
}

func DefaultSettings() Settings {
	return Settings{Theme: "Paper", ThemeDark: "Nord", FollowSystem: true}
}

const (
	appName      = "vibest-desktop"
	settingsFile = "settings.json"
	configEnv    = "VIBEST_DESKTOP_CONFIG_DIR"
	stateEnv     = "VIBEST_DESKTOP_STATE_DIR"
)

func ConfigDir() string {
	return appDir(configEnv, "XDG_CONFIG_HOME", ".config")
}

func StateDir() string {
	return appDir(stateEnv, "XDG_STATE_HOME", filepath.Join(".local", "state"))
}

func appDir(own, xdg, fallback string) string {
	if d := os.Getenv(own); d != "" {
		return d
	}
	if d := os.Getenv(xdg); filepath.IsAbs(d) {
		return filepath.Join(d, appName)
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, fallback, appName)
}

func LoadSettings(dir string) (Settings, error) {
	s := DefaultSettings()
	data, err := os.ReadFile(filepath.Join(dir, settingsFile))
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err == nil {
		err = json.Unmarshal(data, &s)
	}
	if err != nil {
		return DefaultSettings(), err
	}
	d := DefaultSettings()
	if s.Theme == "" {
		s.Theme = d.Theme
	}
	if s.ThemeDark == "" {
		s.ThemeDark = d.ThemeDark
	}
	return s, nil
}

func SaveSettings(dir string, s Settings) error {
	return writeConfig(dir, settingsFile, s)
}

func writeConfig(dir, name string, v any) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	ext := filepath.Ext(name)
	f, err := os.CreateTemp(dir, strings.TrimSuffix(name, ext)+"-*"+ext)
	if err != nil {
		return err
	}
	_, err = f.Write(append(data, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(f.Name(), filepath.Join(dir, name))
	}
	if err != nil {
		os.Remove(f.Name())
	}
	return err
}
