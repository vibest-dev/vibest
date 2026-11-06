package app

import (
	"github.com/egoist/mygo/ui"
	"strings"
	"testing"
	"time"
)

func TestNavigationRightClickRoutingChangesOnlyAfterAdmission(t *testing.T) {
	for _, kind := range []string{"pending", "canceled", "admitted"} {
		t.Run(kind, func(t *testing.T) {
			a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
				if kind != "admitted" {
					f.attachData = map[string]string{"terminal.attach b": "Core fixture ready"}
				}
			})
			id := "a"
			if kind != "admitted" {
				id = "b"
				coreAppAct(a, func() { a.ShowPane(id) })
				tt.Frame()
				tt.Type("x")
				tt.Key(0, ui.KeyEnter)
				if kind == "canceled" {
					coreAppAct(a, func() { a.cancelNavigation() })
				}
				tt.Frame()
				awaitCoreApp(t, a, func() bool { return a.coreViews[id] != nil })
			} else {
				coreOutput(t, a, f, tt, id, "\x1b[?1002h\x1b[?1006h")
			}
			if err := tt.RightClick("terminal/" + id); err != nil {
				t.Fatal(err)
			}
			if err := tt.ChooseMenuItem("Send right-clicks to pane"); err != nil {
				t.Fatal(err)
			}
			if kind != "admitted" {
				if a.rightToPane != nil || !a.coreBlocked {
					t.Fatal("rejected preference changed map or resumed")
				}
				noCoreData(t, f)
				noLegacyNavigation(t, f)
				return
			}
			if !a.rightToPane[id] {
				t.Fatal("admitted preference not stored")
			}
			noCoreData(t, f)
			r := find(t, tt, "terminal/a")
			tt.RightClickAt(r.X+r.W/2, r.Y+r.H/2)
			var press string
			for i := 0; i < 2; i++ {
				select {
				case frame := <-f.inputs:
					f.mu.Lock()
					want := f.channels[id]
					f.mu.Unlock()
					s := string(frame.body)
					if frame.channel != want || !strings.HasPrefix(s, "\x1b[<2;") {
						t.Fatal("right click wrong target/encoding", frame.channel, s)
					}
					if i == 0 {
						press = s
						if !strings.HasSuffix(s, "M") {
							t.Fatal("missing press")
						}
					} else if s != strings.TrimSuffix(press, "M")+"m" {
						t.Fatal("release differs from press", s)
					}
				case <-time.After(time.Second):
					t.Fatal("right click not delivered")
				}
			}
			tt.RightClickAtWith(ui.Shift, r.X+r.W/2, r.Y+r.H/2)
			if err := tt.ChooseMenuItem("Send right-clicks to pane"); err != nil {
				t.Fatal(err)
			}
			if a.rightToPane[id] {
				t.Fatal("modifier escape failed to restore menu routing")
			}
			noCoreData(t, f)
			if len(coreRequests(f, "doc.set"))+len(coreRequests(f, "terminal.run")) != 0 {
				t.Fatal("local preference used backend mutation")
			}
			noLegacyNavigation(t, f)
		})
	}
}

func TestNavigationClearCannotOvertakeHeldInput(t *testing.T) {
	for _, kind := range []string{"pending", "canceled", "admitted"} {
		t.Run(kind, func(t *testing.T) {
			a, f, tt := coreActivityUIWith(t, func(f *coreAppFixture) {
				if kind != "admitted" {
					f.attachData = map[string]string{"terminal.attach b": "Core fixture ready\r\n"}
				}
			})
			id := "a"
			if kind != "admitted" {
				id = "b"
				coreAppAct(a, func() { a.ShowPane(id) })
				tt.Frame()
				tt.Type("held")
				if kind == "canceled" {
					coreAppAct(a, func() { a.cancelNavigation() })
				}
			}
			v := coreOutput(t, a, f, tt, id, "KEEP THIS LINE\r\nnext")
			if !strings.Contains(v.VT.Text(), "KEEP THIS LINE") {
				t.Fatal("missing clear probe")
			}
			if err := tt.RightClick("terminal/" + id); err != nil {
				t.Fatal(err)
			}
			if err := tt.ChooseMenuItem("Clear"); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(v.VT.Text(), "KEEP THIS LINE") != (kind != "admitted") {
				t.Fatal("clear crossed pending boundary or failed ready action")
			}
			noCoreData(t, f)
			if kind != "admitted" {
				if !a.coreBlocked {
					t.Fatal("rejected clear resumed input")
				}
				coreAppAct(a, func() { a.Split(id, "right") })
				if len(coreRequests(f, "terminal.run")) != 0 {
					t.Fatal("header/API split bypassed pending guard")
				}
				coreOutput(t, a, f, tt, id, "\x1b[?9001l")
				coreAppAct(a, func() { a.ShowPane(id) })
				readyCorePane(t, a, tt, id)
			}
			tt.Type("later")
			wantCorePaneInput(t, f, id, "later")
			noCoreData(t, f)
		})
	}
}
