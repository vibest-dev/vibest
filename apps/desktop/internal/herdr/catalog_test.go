package herdr

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCatalog(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	if ms, err := Machines(); err != nil || ms != nil {
		t.Fatalf("no file: %v %v", ms, err)
	}
	dir := catalogDir()
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "endpoints.json"), []byte(`{
  "version": 1,
  "ssh": [
    {"id": "27ab0031b63aa6b154c7999c8da53be8", "label": "mac-mini", "target": "dinq@mac-mini", "session": "default", "enabled": true},
    {"id": "4fb135bc0bd286575939a9c6372d0c62", "label": "mbp", "target": "ssh://dinq@mbp", "session": "default", "enabled": false}
  ]
}`), 0o600)
	ms, err := Machines()
	if err != nil || len(ms) != 2 || ms[0].Target != "dinq@mac-mini" || !ms[0].Enabled || ms[1].Enabled {
		t.Fatalf("%+v %v", ms, err)
	}
	if SelectedMachine() != "" {
		t.Fatal("selected without a selection file")
	}
	for _, id := range []string{ms[0].ID, ""} {
		if err := SelectMachine(id); err != nil {
			t.Fatal(err)
		}
		if got := SelectedMachine(); got != id {
			t.Fatalf("selected %q, want %q", got, id)
		}
	}
}
