package herdr

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"os"
	"reflect"
	"testing"
	"time"
)

type fixtureStep struct {
	frame, kind, data string
	want              *Surface
}

func fixture(t *testing.T, name string) (base []byte, first *Surface, steps []fixtureStep) {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReaderSize(bytes.NewReader(b), len(b))
	surface := func() *Surface {
		msg, err := readFrame(r)
		if err != nil {
			t.Fatal(err)
		}
		d := &dec{b: msg}
		if d.uint() != msgSurface {
			t.Fatal("not a surface")
		}
		sf := d.surface()
		if d.err != nil || len(d.b) != 0 {
			t.Fatal("bad surface", d.err)
		}
		return sf
	}
	first = surface()
	base = b[:len(b)-r.Buffered()]
	for r.Buffered() > 0 {
		msg, err := readFrame(r)
		if err != nil {
			t.Fatal(err)
		}
		d := &dec{b: msg}
		if d.uint() != msgControl {
			t.Fatal("not a control")
		}
		st := fixtureStep{frame: string(append(binary.LittleEndian.AppendUint32(nil, uint32(len(msg))), msg...)), kind: d.str(), data: d.str()}
		st.want = surface()
		steps = append(steps, st)
	}
	return base, first, steps
}

var fixtures = []string{"surface-scroll-up-v1.bin", "surface-scroll-down-v1.bin", "surface-delta-v1.bin"}

func TestHerdrEncoderFixtures(t *testing.T) {
	for _, name := range fixtures {
		t.Run(name, func(t *testing.T) {
			_, cur, steps := fixture(t, name)
			if len(steps) == 0 {
				t.Fatal("no steps")
			}
			for i, st := range steps {
				if st.kind != scrollKind && st.kind != deltaKind {
					t.Fatalf("kind %s", st.kind)
				}
				s := &Shell{surface: cur}
				if err := s.update(st.kind, st.data); err != nil {
					t.Fatalf("step %d: %v", i, err)
				}
				if !reflect.DeepEqual(s.surface, st.want) {
					t.Fatalf("step %d (%s) differs from herdr's surface", i, st.kind)
				}
				cur = s.surface
			}
		})
	}
}

func TestFixturesOverAConnection(t *testing.T) {
	for _, name := range fixtures {
		t.Run(name, func(t *testing.T) {
			base, first, steps := fixture(t, name)
			s, f, _, ran := connect(t)
			shown := make(chan *Surface, 1)
			s.OnSurface = func(sf *Surface) { shown <- sf }
			s.OnSnapshot = func(*ShellSnapshot) {}
			f.snapshot(first.Boot, first.Projection)
			f.conn.Write(base)
			got := next(t, shown, ran)
			for i, st := range steps {
				if st.want.Projection != got.Projection {
					f.snapshot(st.want.Boot, st.want.Projection)
				}
				prev, cells := got, append([]Cell(nil), got.Frame.Cells...)
				f.conn.Write([]byte(st.frame))
				got = next(t, shown, ran)
				if !reflect.DeepEqual(got, st.want) {
					t.Fatalf("step %d differs from herdr's surface", i)
				}
				if !reflect.DeepEqual(prev.Frame.Cells, cells) {
					t.Fatalf("step %d changed the surface shown before it", i)
				}
			}
		})
	}
}

func TestRejectedDeltaKeepsTheSurface(t *testing.T) {
	_, cur, steps := fixture(t, "surface-delta-v1.bin")
	before := *cur
	before.Frame.Cells = append([]Cell(nil), cur.Frame.Cells...)
	cur.Revision++
	s := &Shell{surface: cur}
	if err := s.update(steps[0].kind, steps[0].data); err == nil {
		t.Fatal("a delta of another revision applied")
	}
	if !reflect.DeepEqual(cur.Frame.Cells, before.Frame.Cells) {
		t.Fatal("a rejected delta changed the cells")
	}
}

func next(t *testing.T, shown chan *Surface, ran chan error) *Surface {
	t.Helper()
	select {
	case sf := <-shown:
		return sf
	case err := <-ran:
		t.Fatalf("Run ended: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("no surface")
	}
	return nil
}
