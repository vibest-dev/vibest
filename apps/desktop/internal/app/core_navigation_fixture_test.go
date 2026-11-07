package app

import (
	"github.com/egoist/mygo/ui"
	"testing"
	"time"
)

func navigationWait(t *testing.T, f func() bool) {
	t.Helper()
	end := time.Now().Add(3 * time.Second)
	for !f() {
		if time.Now().After(end) {
			t.Fatal("fixture callback did not arrive")
		}
		time.Sleep(time.Millisecond)
	}
}
func terminalWorkspace(t *testing.T, tt *ui.Tester, label string) {
	t.Helper()
	if err := tt.Click("Terminals"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem(label, "Open"); err != nil {
		t.Fatal(err)
	}
}

func navigationRelease(t *testing.T, tt *ui.Tester, label string) {
	t.Helper()
	r := find(t, tt, label)
	tt.Press(r.X+r.W/2, r.Y+r.H/2)
	tt.ReleaseUnframed(r.X+r.W/2, r.Y+r.H/2)
}
