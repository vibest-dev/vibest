package app

import (
	"bytes"
	"fmt"
	"github.com/egoist/mygo/ui"
	"image"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
	"vibest-desktop/internal/coreview"
)

func coreGridFixture(t *testing.T) (*App, *coreAppFixture, *ui.Tester) {
	t.Helper()
	if os.Getenv("MYGO_GHOSTTY_VT") == "" {
		t.Fatal("explicit verified software VT library required")
	}
	a, f := newCoreAppFixtureWith(t, coreActivitySeed)
	coreAppAct(a, func() { a.look.NoBlink = true })
	tt := ui.NewTester(a.View, 1280, 800)
	readyCorePane(t, a, tt, "a")
	return a, f, tt
}

func vtView(t *testing.T, v *coreview.Terminal) reflect.Value {
	t.Helper()
	r := reflect.ValueOf(v.VT).Elem().FieldByName("v")
	if r.IsNil() {
		t.Fatal("no painted VT view")
	}
	return r.Elem()
}
func coreOutput(t *testing.T, a *App, f *coreAppFixture, tt *ui.Tester, id, output string) *coreview.Terminal {
	t.Helper()
	awaitCoreApp(t, a, func() bool { return a.coreViews[id] != nil })
	a.mu.Lock()
	v := a.coreViews[id]
	ref := a.coreAttached[id]
	a.mu.Unlock()
	f.mu.Lock()
	address := ref.Address
	if _, local, remote := strings.Cut(address, "/"); remote {
		address = ref.CoreID + "/" + local
	}
	ch := f.channels[address]
	f.outputs++
	marker := fmt.Sprintf("fixture-output-%d", f.outputs)
	f.mu.Unlock()
	if ch == 0 {
		t.Fatal("no attached channel for " + id)
	}
	f.send(ch, []byte(output+"\x1b]2;"+marker+"\x07"))
	deadline := time.Now().Add(time.Second)
	for v.VT.Title() != marker {
		if time.Now().After(deadline) {
			t.Fatal("output not parsed")
		}
		tt.Frame()
		time.Sleep(time.Millisecond)
	}
	tt.Frame()
	tt.Frame()
	return v
}
func vtCell(t *testing.T, tt *ui.Tester, v *coreview.Terminal, id string, col, row int) image.Rectangle {
	t.Helper()
	state := vtView(t, v)
	scale := state.FieldByName("scale").Float()
	r := find(t, tt, "terminal/"+id)
	x := int(math.Round(float64(r.X)*scale)) + int(state.FieldByName("ox").Int()) + col*int(state.FieldByName("cellW").Int())
	y := int(math.Round(float64(r.Y)*scale)) + int(state.FieldByName("oy").Int()) + row*int(state.FieldByName("cellH").Int())
	b := image.Rect(x, y, x+int(state.FieldByName("cellW").Int()), y+int(state.FieldByName("cellH").Int()))
	if !b.In(tt.Image().Bounds()) {
		t.Fatalf("cell %v outside render", b)
	}
	return b
}
func cellPixels(tt *ui.Tester, r image.Rectangle) []byte {
	var out []byte
	im := tt.Image()
	for y := r.Min.Y; y < r.Max.Y; y++ {
		offset := im.PixOffset(r.Min.X, y)
		out = append(out, im.Pix[offset:offset+r.Dx()*4]...)
	}
	return out
}
func rowGlyphs(t *testing.T, v *coreview.Terminal, row int) uintptr {
	t.Helper()
	lines := vtView(t, v).FieldByName("lines")
	if lines.Len() <= row {
		t.Fatal("no rendered row")
	}
	runs := lines.Index(row).FieldByName("runs")
	if runs.Len() == 0 {
		t.Fatal("no populated glyph cache")
	}
	return runs.Pointer()
}
func assertPopulatedCursor(t *testing.T, tt *ui.Tester, r image.Rectangle) {
	t.Helper()
	im := tt.Image()
	corner := im.RGBAAt(r.Min.X+1, r.Min.Y+1)
	ink := 0
	for y := r.Min.Y + 1; y < r.Max.Y-1; y++ {
		for x := r.Min.X + 1; x < r.Max.X-1; x++ {
			if im.RGBAAt(x, y) != corner {
				ink++
			}
		}
	}
	if ink < 3 {
		t.Fatalf("block cursor hides populated character: ink=%d", ink)
	}
}
func TestPaneFontSmoothing(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[2;2HMMmmm\x1b[?25l")
	r := vtCell(t, tt, v, "a", 1, 1)
	before := cellPixels(tt, r)
	font := vtView(t, v).FieldByName("fonts").Index(0)
	if font.FieldByName("Thicken").Bool() || !font.FieldByName("Antialiased").Bool() {
		t.Fatal("default unexpectedly thickened")
	}
	coreAppAct(a, func() { a.look.Font.Thicken = true })
	tt.Frame()
	tt.Frame()
	if !vtView(t, v).FieldByName("fonts").Index(0).FieldByName("Thicken").Bool() || vtView(t, v).FieldByName("fonts").Index(0).FieldByName("Antialiased").Bool() {
		t.Fatal("font-thicken did not reach actual VT renderer")
	}
	if bytes.Equal(before, cellPixels(tt, r)) {
		t.Fatal("font smoothing/thickening did not change rendered glyphs")
	}
	coreAppAct(a, func() { a.look.Font.Thicken = false })
	tt.Frame()
	tt.Frame()
	if !bytes.Equal(before, cellPixels(tt, r)) {
		t.Fatal("ordinary smoothing did not restore")
	}
}
func TestMultiPaneBlockCursorKeepsText(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[4;4HM M\x1b[4;4H\x1b[2 q\x1b[?25h")
	assertPopulatedCursor(t, tt, vtCell(t, tt, v, "a", 3, 3))
	cache := rowGlyphs(t, v, 3)
	coreOutput(t, a, f, tt, "b", "\x1b[2J\x1b[HSecond pane changed")
	coreOutput(t, a, f, tt, "a", "\x1b[4;6H")
	assertPopulatedCursor(t, tt, vtCell(t, tt, v, "a", 5, 3))
	if rowGlyphs(t, v, 3) != cache {
		t.Fatal("sibling output/cursor move rebuilt populated row")
	}
}
func TestCursorBlinkKeepsTheRowCache(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[4;4HM\x1b[4;4H\x1b[2 q\x1b[?25h")
	cache := rowGlyphs(t, v, 3)
	r := vtCell(t, tt, v, "a", 3, 3)
	on := cellPixels(tt, r)
	for _, seq := range []string{"\x1b[?25l", "\x1b[?25h\x1b[4 q", "\x1b[6 q"} {
		coreOutput(t, a, f, tt, "a", seq)
		if rowGlyphs(t, v, 3) != cache {
			t.Fatal("cursor change rebuilt row cache")
		}
		if bytes.Equal(on, cellPixels(tt, r)) {
			t.Fatal("cursor style left filled block unchanged")
		}
	}
	coreOutput(t, a, f, tt, "a", "\x1b[2 q")
	if !bytes.Equal(on, cellPixels(tt, r)) {
		t.Fatal("steady block did not restore")
	}
	tt.Compose("qq", 2)
	if rowGlyphs(t, v, 3) != cache {
		t.Fatal("preedit rebuilt ordinary text cache")
	}
	tt.Compose("", 0)
}
func TestTabSwitchRetainsIndependentRenderers(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	first := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[Hretained history")
	coreAppAct(a, func() { a.SelectTab("t2") })
	second := readyCorePane(t, a, tt, "c")
	coreOutput(t, a, f, tt, "c", "other terminal")
	coreAppAct(a, func() { a.SelectTab("t1") })
	again := readyCorePane(t, a, tt, "a")
	if again != first || again.VT == second.VT || !strings.Contains(again.VT.Text(), "retained history") {
		t.Fatal("tab switch replaced/shared terminal state")
	}
}
func TestVTResizeKeepsRendererAndClipsPadding(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[41m\x1b[2J\x1b[?25l")
	for _, width := range []int{1280, 1271, 1280} {
		tt.SetSize(width, 800)
		if readyCorePane(t, a, tt, "a") != v {
			t.Fatal("resize recreated renderer")
		}
		r := find(t, tt, "terminal/a")
		im := tt.Image()
		if im.RGBAAt(int(r.X+r.W)-2, int(r.Y+r.H/2)).A != 255 {
			t.Fatal("terminal edge sampled transparent padding")
		}
	}
}
func TestPartialRowIsNotAReportedRow(t *testing.T) {
	a, _, tt := coreGridFixture(t)
	v := readyCorePane(t, a, tt, "a")
	for _, height := range []int{799, 800, 801} {
		tt.SetSize(1280, height)
		readyCorePane(t, a, tt, "a")
		state := vtView(t, v)
		r := find(t, tt, "terminal/a")
		scale := state.FieldByName("scale").Float()
		want := int(math.Round(float64(r.H)*scale)) - 2*int(state.FieldByName("oy").Int())
		want /= int(state.FieldByName("cellH").Int())
		_, rows := v.VT.Size()
		if rows != want {
			t.Fatalf("height %d reports %d rows, want %d complete rows", height, rows, want)
		}
	}
}
func TestFramedTitleCentered(t *testing.T) {
	a, _, tt := coreGridFixture(t)
	coreAppAct(a, func() { a.RenamePane("a", "TITLE") })
	awaitCoreApp(t, a, func() bool { return a.coreState.Layout.Pane("a").Label == "TITLE" })
	tt.Frame()
	tt.Frame()
	title, card, term := find(t, tt, "TITLE"), find(t, tt, "pane/a"), find(t, tt, "terminal/a")
	header := find(t, tt, "pane-header/a")
	if term.Y-card.Y != headH || header.Y != card.Y || header.H != headH || title.Y < header.Y || title.Y+title.H > term.Y || !near1(title.Y+title.H/2, header.Y+header.H/2, .5/a.g.scale) {
		t.Fatalf("title outside header: title=%v card=%v terminal=%v", title, card, term)
	}
}
func TestFramedCaretFollowsTheShift(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[4;4H")
	for _, scale := range []float32{1, 2} {
		tt.SetScale(scale)
		readyCorePane(t, a, tt, "a")
		for _, height := range []float32{0, 36} {
			tt.SetTitleBar(ui.TitleBar{Height: height, Left: 78})
			tt.Frame()
			tt.Frame()
			r, active := tt.TextCaret()
			cell := vtCell(t, tt, v, "a", 3, 3)
			if !active || math.Abs(float64(r.Y)-float64(cell.Min.Y)/float64(scale)) > .6 || r.Y < find(t, tt, "terminal/a").Y {
				t.Fatalf("shifted caret %v active=%v expected cell %v scale=%v", r, active, cell, scale)
			}
		}
	}
}
func TestCellsThroughCoreVT(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[2;1H中👍───\x1b[3;9H\x1b[2 q")
	im := tt.Image()
	bg := im.RGBAAt(vtCell(t, tt, v, "a", 10, 1).Min.X+1, vtCell(t, tt, v, "a", 10, 1).Min.Y+1)
	ink := func(col, row int) bool {
		r := vtCell(t, tt, v, "a", col, row)
		for y := r.Min.Y; y < r.Max.Y; y++ {
			for x := r.Min.X; x < r.Max.X; x++ {
				if tt.Image().RGBAAt(x, y) != bg {
					return true
				}
			}
		}
		return false
	}
	for col := 0; col < 4; col++ {
		if !ink(col, 1) {
			t.Fatalf("wide character half %d blank", col)
		}
	}
	for _, col := range []int{5, 6} {
		r := vtCell(t, tt, v, "a", col, 1)
		for _, x := range []int{r.Min.X - 1, r.Min.X} {
			lit := false
			for y := r.Min.Y + r.Dy()/2 - 2; y <= r.Min.Y+r.Dy()/2+1; y++ {
				lit = lit || tt.Image().RGBAAt(x, y) != bg
			}
			if !lit {
				t.Fatal("box line breaks between cells")
			}
		}
	}
	if !ink(8, 2) || ink(10, 2) {
		t.Fatal("cursor/blank cell geometry wrong")
	}
	tt.Compose("ああ", 2)
	if !ink(10, 2) {
		t.Fatal("preedit not drawn beyond cursor")
	}
	tt.Compose("", 0)
	start, end := vtCell(t, tt, v, "a", 0, 1), vtCell(t, tt, v, "a", 3, 1)
	tt.Press(float32(start.Min.X+1), float32(start.Min.Y+start.Dy()/2))
	tt.Move(float32(end.Max.X-1), float32(end.Min.Y+end.Dy()/2))
	tt.Release(float32(end.Max.X-1), float32(end.Min.Y+end.Dy()/2))
	tt.Command("copy")
	if !strings.Contains(tt.Clipboard(), "中") || !strings.Contains(tt.Clipboard(), "👍") {
		t.Fatalf("wide selection/copy=%q", tt.Clipboard())
	}
}
func TestFontChangeUpdatesVTGlyphs(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[HMmmm")
	before := vtCell(t, tt, v, "a", 0, 0)
	cache := rowGlyphs(t, v, 0)
	coreAppAct(a, func() { a.fontSize = a.lookSize() + 4 })
	readyCorePane(t, a, tt, "a")
	after := vtCell(t, tt, v, "a", 0, 0)
	if after.Dy() <= before.Dy() || rowGlyphs(t, v, 0) == cache {
		t.Fatal("font change retained old dimensions/glyphs")
	}
}
func TestBlurHollowsTheCursor(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	v := coreOutput(t, a, f, tt, "a", "\x1b[2J\x1b[2;4H\x1b[2 q\x1b[?25h")
	r := vtCell(t, tt, v, "a", 3, 1)
	on := tt.Image().RGBAAt(r.Min.X+r.Dx()/2, r.Min.Y+r.Dy()/2)
	a.Focus(false)
	tt.SetFocused(false)
	tt.Frame()
	tt.Frame()
	off := tt.Image().RGBAAt(r.Min.X+r.Dx()/2, r.Min.Y+r.Dy()/2)
	if on == off {
		t.Fatal("unfocused cursor kept filled block")
	}
	a.Focus(true)
	tt.SetFocused(true)
	if readyCorePane(t, a, tt, "a") != v {
		t.Fatal("blur recreated renderer")
	}
}
func TestCursorOnWideTailShowsTheCharacter(t *testing.T) {
	a, f, tt := coreGridFixture(t)
	for _, id := range []string{"a", "b"} {
		coreAppAct(a, func() { a.ShowPane(id) })
		v := readyCorePane(t, a, tt, id)
		cols, _ := v.VT.Size()
		col := 0
		if id == "b" {
			col = cols - 2
		}
		coreOutput(t, a, f, tt, id, fmt.Sprintf("\x1b[2J\x1b[2;%dH中\x1b[2;%dH\x1b[2 q", col+1, col+2))
		left, right := vtCell(t, tt, v, id, col, 1), vtCell(t, tt, v, id, col+1, 1)
		assertPopulatedCursor(t, tt, left.Union(right))
		if tt.Image().RGBAAt(left.Min.X+1, left.Min.Y+1) != tt.Image().RGBAAt(right.Min.X+1, right.Min.Y+1) {
			t.Fatal("wide tail cursor did not cover both cells")
		}
	}
}
