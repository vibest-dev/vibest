package chrome

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/egoist/mygo"
)

var _ mygo.WindowStateStore = WindowStates{}

func TestDirs(t *testing.T) {
	t.Setenv("HOME", "/home/u")
	for _, v := range []string{"XDG_CONFIG_HOME", "XDG_STATE_HOME", "VIBEST_DESKTOP_CONFIG_DIR", "VIBEST_DESKTOP_STATE_DIR"} {
		t.Setenv(v, "")
	}
	check := func(what, config, state string) {
		t.Helper()
		if got := ConfigDir(); got != config {
			t.Errorf("%s: config %s, want %s", what, got, config)
		}
		if got := StateDir(); got != state {
			t.Errorf("%s: state %s, want %s", what, got, state)
		}
	}
	check("home", "/home/u/.config/vibest-desktop", "/home/u/.local/state/vibest-desktop")
	t.Setenv("XDG_CONFIG_HOME", "rel/config")
	t.Setenv("XDG_STATE_HOME", "./state")
	check("relative XDG", "/home/u/.config/vibest-desktop", "/home/u/.local/state/vibest-desktop")
	t.Setenv("XDG_CONFIG_HOME", "/xdg/config")
	t.Setenv("XDG_STATE_HOME", "/xdg/state")
	check("XDG", "/xdg/config/vibest-desktop", "/xdg/state/vibest-desktop")
	t.Setenv("VIBEST_DESKTOP_CONFIG_DIR", "/home/u/.config/vibest-desktop-dev")
	check("config only", "/home/u/.config/vibest-desktop-dev", "/xdg/state/vibest-desktop")
	t.Setenv("VIBEST_DESKTOP_STATE_DIR", "/home/u/.local/state/vibest-desktop-dev")
	check("both", "/home/u/.config/vibest-desktop-dev", "/home/u/.local/state/vibest-desktop-dev")
}

type profile struct {
	t                    *testing.T
	config, state        string
	settings, legacyData []byte
}

func newProfile(t *testing.T, root, name string) *profile {
	p := &profile{t: t, config: filepath.Join(root, "config", name), state: filepath.Join(root, "state", name)}
	if err := SaveSettings(p.config, Settings{Theme: "Ink", ThemeDark: "Nord"}); err != nil {
		t.Fatal(err)
	}
	p.settings = p.read(p.config, settingsFile)
	return p
}

func (p *profile) store() WindowStates { return WindowStates{Dir: p.state, Legacy: p.config} }

func (p *profile) read(dir, name string) []byte {
	data, _ := os.ReadFile(filepath.Join(dir, name))
	return data
}

func (p *profile) write(dir, data string) {
	p.t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		p.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, windowStateFile), []byte(data), 0o644); err != nil {
		p.t.Fatal(err)
	}
}

func (p *profile) legacy(data string) {
	p.write(p.config, data)
	p.legacyData = []byte(data)
}

func (p *profile) kept() {
	p.t.Helper()
	if got := p.read(p.config, settingsFile); string(got) != string(p.settings) {
		p.t.Errorf("settings.json became %s", got)
	}
	if got := p.read(p.config, windowStateFile); string(got) != string(p.legacyData) {
		p.t.Errorf("the legacy window-state.json became %q, want %q", got, p.legacyData)
	}
	for _, dir := range []string{p.config, p.state} {
		names, _ := filepath.Glob(filepath.Join(dir, "*-[0-9]*.json"))
		if len(names) != 0 {
			p.t.Errorf("temporary files %v", names)
		}
	}
}

func (p *profile) load(want map[string]mygo.WindowState, wantErr bool) {
	p.t.Helper()
	got, err := p.store().LoadWindowStates()
	if (err != nil) != wantErr || !reflect.DeepEqual(got, want) {
		p.t.Fatalf("loaded %v, %v; want %v, error %v", got, err, want, wantErr)
	}
}

const legacyJSON = `{"main": {"x": 10, "y": 20, "width": 1400, "height": 850}}`

var legacyStates = map[string]mygo.WindowState{"main": {X: 10, Y: 20, Width: 1400, Height: 850}}

func TestWindowStatesRoundTrip(t *testing.T) {
	root := t.TempDir()
	main, dev := newProfile(t, root, "vibest-desktop"), newProfile(t, root, "vibest-desktop-dev")
	main.load(nil, false)
	if _, err := os.Stat(main.state); !os.IsNotExist(err) {
		t.Fatalf("loading created the state directory: %v", err)
	}
	want := map[string]mygo.WindowState{"main": {X: 40, Y: 60, Width: 1500, Height: 900, Maximized: true}}
	if err := main.store().SaveWindowStates(want); err != nil {
		t.Fatal(err)
	}
	main.load(want, false)
	dev.load(nil, false)
	if _, err := os.Stat(dev.state); !os.IsNotExist(err) {
		t.Fatalf("the other profile's state was created: %v", err)
	}
	next := map[string]mygo.WindowState{"main": {Y: 25, Width: 1280, Height: 800}}
	if err := main.store().SaveWindowStates(next); err != nil {
		t.Fatal(err)
	}
	main.load(next, false)
	if main.read(main.config, windowStateFile) != nil {
		t.Fatal("saved into the configuration")
	}
	main.kept()
	dev.kept()
}

func TestWindowStatesMoveFromTheConfiguration(t *testing.T) {
	p := newProfile(t, t.TempDir(), "vibest-desktop-dev")
	p.legacy(legacyJSON)
	p.load(legacyStates, false)
	p.kept()
	if got, err := readStates(p.state); err != nil || !reflect.DeepEqual(got, legacyStates) {
		t.Fatalf("state file %v, %v", got, err)
	}
	p.legacy(`{"main": {"x": 0, "y": 0, "width": 640, "height": 480}}`)
	p.load(legacyStates, false)
	p.kept()
}

func TestWindowStatesStateFileWins(t *testing.T) {
	p := newProfile(t, t.TempDir(), "vibest-desktop")
	p.legacy(legacyJSON)
	own := `{"main": {"x": 1, "y": 2, "width": 900, "height": 700}}`
	p.write(p.state, own)
	p.load(map[string]mygo.WindowState{"main": {X: 1, Y: 2, Width: 900, Height: 700}}, false)
	for _, bad := range []string{"{", "[1, 2]", `{"main": {"width": "wide"}}`, "\x00\xff"} {
		p.write(p.state, bad)
		p.load(nil, true)
		if got := p.read(p.state, windowStateFile); string(got) != bad {
			t.Errorf("%q: loading rewrote it as %q", bad, got)
		}
	}
	path := filepath.Join(p.state, windowStateFile)
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(path, 0o644)
	if _, err := os.ReadFile(path); err == nil {
		t.Skip("the file stayed readable (running as root?)")
	}
	p.load(nil, true)
	p.kept()
}

func TestWindowStatesKeepDanglingStateEntry(t *testing.T) {
	p := newProfile(t, t.TempDir(), "vibest-desktop")
	p.legacy(legacyJSON)
	if err := os.MkdirAll(p.state, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(p.state, windowStateFile)
	target := filepath.Join(t.TempDir(), "missing-state.json")
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	p.load(nil, true)
	if got, err := os.Readlink(path); err != nil || got != target {
		t.Fatalf("unreadable state entry replaced: target %q, error %v", got, err)
	}
	p.kept()
}

func TestWindowStatesLeaveABadLegacy(t *testing.T) {
	p := newProfile(t, t.TempDir(), "vibest-desktop")
	p.load(nil, false)
	for _, bad := range []string{"{", "[1, 2]", `{"main": {"width": "wide"}}`, "\x00\xff", "{}", "null"} {
		p.legacy(bad)
		p.load(nil, false)
		if _, err := os.Stat(p.state); !os.IsNotExist(err) {
			t.Fatalf("%q: state directory %v", bad, err)
		}
		p.kept()
	}
	if got, err := (WindowStates{Dir: p.state}).LoadWindowStates(); got != nil || err != nil {
		t.Fatalf("no legacy: %v, %v", got, err)
	}
}

func TestWindowStatesFailedSave(t *testing.T) {
	p := newProfile(t, t.TempDir(), "vibest-desktop")
	old := map[string]mygo.WindowState{"main": {X: 1, Y: 2, Width: 900, Height: 700}}
	if err := p.store().SaveWindowStates(old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p.state, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(p.state, 0o755)
	if err := p.store().SaveWindowStates(map[string]mygo.WindowState{"main": {Width: 10, Height: 10}}); err == nil {
		t.Skip("the directory stayed writable (running as root?)")
	}
	p.load(old, false)
	p.kept()
	locked := t.TempDir()
	if err := os.Chmod(locked, 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(locked, 0o755)
	q := newProfile(t, t.TempDir(), "vibest-desktop")
	q.legacy(legacyJSON)
	dir := filepath.Join(locked, "vibest-desktop")
	if got, err := (WindowStates{Dir: dir, Legacy: q.config}).LoadWindowStates(); err != nil || !reflect.DeepEqual(got, legacyStates) {
		t.Fatalf("unsaved carry-over: %v, %v", got, err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("state directory %v", err)
	}
	q.kept()
}
