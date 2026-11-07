package app

import (
	"slices"
	"sync"
	"testing"
	"time"

	"vibest-desktop/internal/chrome"
)

func TestTranslucentWindowIsOptInAndNeedsTheWindowMaterial(t *testing.T) {
	dir := t.TempDir()
	app, tt, _ := themedApp(t, dir)
	var mu sync.Mutex
	var vibrancy []bool
	app.Attach(Host{SetVibrancy: func(on bool) { mu.Lock(); vibrancy = append(vibrancy, on); mu.Unlock() }})
	settle := func(want []bool) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for {
			mu.Lock()
			got := slices.Clone(vibrancy)
			mu.Unlock()
			if slices.Equal(got, want) {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("window vibrancy %v, want %v", got, want)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	tt.SetDark(false)
	tt.SetVibrancy(true)
	tt.Frame()
	settle([]bool{false})
	if app.th != chrome.Light {
		t.Fatalf("theme %q translucent by default", app.th.Name)
	}
	if err := tt.Click("Theme"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Translucent Window"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	settle([]bool{false, true})
	if app.th != chrome.Light.Glass() {
		t.Fatalf("theme %q is not the translucent Paper", app.th.Name)
	}
	if got := tt.Image().RGBAAt(4, 300); got.A == 255 {
		t.Fatalf("sidebar %v is opaque over the window material", got)
	}
	if s, _ := chrome.LoadSettings(dir); !s.Translucent {
		t.Fatalf("saved %+v", s)
	}
	tt.SetVibrancy(false)
	tt.Frame()
	if app.th != chrome.Light {
		t.Fatal("translucent theme without a window material behind it")
	}
}
