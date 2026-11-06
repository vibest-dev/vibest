package app

import (
	"fmt"
	"github.com/egoist/mygo/plugins/terminal"
	"github.com/egoist/mygo/ui"
	"io"
	"os"
	"runtime"
	"strings"
	"testing"
)

type benchFeedConn struct{ *io.PipeReader }

func (c benchFeedConn) Write(b []byte) (int, error) { return len(b), nil }
func benchVT(b *testing.B) (*terminal.Terminal, *ui.Tester) {
	b.Helper()
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		b.Fatal("explicit verified VT required")
	}
	reader, writer := io.Pipe()
	v, e := terminal.New(terminal.Options{Conn: benchFeedConn{reader}, NoBlink: true, NoClipboardWrite: true, ImageLimit: 16 << 20})
	if e != nil {
		b.Fatal(e)
	}
	b.Cleanup(func() { v.Close(); writer.Close() })
	tt := ui.NewTester(func(c *ui.Context) { terminal.View(c, v).Fill() }, 1920, 1080)
	tt.Frame()
	v.Feed([]byte(strings.Repeat("actual software VT row\r\n", 80)))
	tt.Frame()
	return v, tt
}
func BenchmarkFrameIdle(b *testing.B) {
	_, tt := benchVT(b)
	b.ReportAllocs()
	for b.Loop() {
		tt.Frame()
	}
}
func BenchmarkFrameOneRow(b *testing.B) {
	v, tt := benchVT(b)
	b.ReportAllocs()
	for b.Loop() {
		v.Feed([]byte("\x1b[1;1Hupdated row"))
		tt.Frame()
	}
}
func BenchmarkCursorBlink(b *testing.B) {
	v, tt := benchVT(b)
	b.ReportAllocs()
	on := true
	for b.Loop() {
		if on {
			v.Feed([]byte("\x1b[?25l"))
		} else {
			v.Feed([]byte("\x1b[?25h"))
		}
		on = !on
		tt.Frame()
	}
}
func BenchmarkFrameAllRows(b *testing.B) {
	v, tt := benchVT(b)
	data := []byte(strings.Repeat("full redraw\r\n", 80))
	b.ReportAllocs()
	for b.Loop() {
		v.Feed(data)
		tt.Frame()
	}
}
func TestReportRetained(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "retained VT output")
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for range 50 {
		tt.Frame()
	}
	runtime.GC()
	runtime.ReadMemStats(&after)
	if a.coreViews["a"] != v || !strings.Contains(v.VT.Text(), "retained VT output") {
		t.Fatal("idle frames replaced renderer/output")
	}
	cols, rows := v.VT.Size()
	t.Logf("Core VT %dx%d heap in use delta %d KiB", cols, rows, (int64(after.HeapInuse)-int64(before.HeapInuse))/1024)
	tt.Type("after idle")
	wantCorePaneInput(t, f, "a", "after idle")
}
func TestReportShapedGrowth(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := a.coreViews["a"]
	for frame := range 400 {
		coreOutput(t, a, f, tt, "a", fmt.Sprintf("unique output %d abcdefghijklmnopqrstuvwxyz\r\n", frame))
		if frame%100 == 99 {
			var m runtime.MemStats
			runtime.GC()
			runtime.ReadMemStats(&m)
			t.Logf("frame %d heap in use %d KiB", frame+1, m.HeapInuse/1024)
		}
	}
	if a.coreViews["a"] != v || !strings.Contains(v.VT.Text(), "unique output 399") {
		t.Fatal("real VT scrolling lost renderer/output")
	}
	tt.Type("after scroll")
	wantCorePaneInput(t, f, "a", "after scroll")
}
