package app

import (
	"strings"
	"testing"

	"github.com/egoist/mygo/transfer"
)

func TestCoreClipboardProviderMustKeepOriginalPasteLease(t *testing.T) {
	a, f, tt := coreActivityUI(t)
	tt.SetClipboardEager(true)
	called := false
	tt.SetClipboardData(transfer.New(transfer.NewItem(transfer.Lazy(transfer.FileList, func() ([]byte, error) {
		called = true
		a.Focus(false)
		a.Focus(true)
		tt.Frame()
		return []byte("file:///inert/provider-owned"), nil
	}))))
	tt.Command("paste")
	if !called {
		t.Fatal("provider seam not reached")
	}
	tt.Type("fresh")
	wantCorePaneInput(t, f, "a", "fresh")
	noCoreData(t, f)
}

func TestCoreClipboardProviderReentryLazyAndEager(t *testing.T) {
	for _, eager := range []bool{false, true} {
		for _, change := range []string{"none", "blur-return", "pane"} {
			t.Run(map[bool]string{false: "lazy/", true: "eager/"}[eager]+change, func(t *testing.T) {
				a, f, tt := coreActivityUI(t)
				tt.SetClipboardEager(eager)
				called := false
				target := "a"
				tt.SetClipboardData(transfer.New(transfer.NewItem(transfer.Lazy(transfer.FileList, func() ([]byte, error) {
					called = true
					switch change {
					case "blur-return":
						a.Focus(false)
						a.Focus(true)
						tt.Frame()
					case "pane":
						coreAppAct(a, func() { a.ShowPane("b") })
						readyCorePane(t, a, tt, "b")
						target = "b"
					}
					return []byte("file:///inert/provider%20owned"), nil
				}))))
				tt.Command("paste")
				if !called {
					t.Fatal("provider seam not reached")
				}
				if change == "none" {
					wantCorePaneInput(t, f, "a", shellEscape("/inert/provider owned"))
				}
				tt.Type("fresh")
				wantCorePaneInput(t, f, target, "fresh")
				noCoreData(t, f)
			})
		}
	}
}

func TestCoreClipboardEagerRemoteRefusesBeforeProvider(t *testing.T) {
	a, f, tt := coreMachineUI(t)
	navigationRelease(t, tt, "machine: Remote")
	wantRemoteNavigation(t, a, f, tt, "d")
	tt.SetClipboardEager(true)
	called := false
	tt.SetClipboardData(transfer.New(transfer.NewItem(transfer.Lazy(transfer.PNG, func() ([]byte, error) { called = true; return []byte("never materialize"), nil }))))
	tt.Command("paste")
	if called {
		t.Fatal("remote paste acquired the clipboard")
	}
	noCoreData(t, f)
}

func TestCoreClipboardProviderCapacityRefusalDoesNotPoisonTyping(t *testing.T) {
	for _, eager := range []bool{false, true} {
		t.Run(map[bool]string{false: "lazy", true: "eager"}[eager], func(t *testing.T) {
			a, f, tt := coreActivityUI(t)
			tt.SetClipboardEager(eager)
			tt.SetClipboard(strings.Repeat("x", navigationBytes+1))
			tt.Command("paste")
			awaitCoreApp(t, a, func() bool { return a.navigationNote == "Paste refused: text is too long" })
			noCoreData(t, f)
			tt.Type("fresh")
			wantCorePaneInput(t, f, "a", "fresh")
			noCoreData(t, f)
		})
	}
}
