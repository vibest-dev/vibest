package ghostty

import (
	"io/fs"
	"strings"
	"testing"

	"github.com/egoist/mygo/plugins/terminal"
)

func TestChooseFamilies(t *testing.T) {
	ok := func([]string) bool { return true }
	fail := func([]string) bool { return false }
	eq := func(got []string, want ...string) {
		t.Helper()
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("got %q, want %q", got, want)
		}
	}

	eq(chooseFamilies(nil, map[string]bool{symbolsMonoFamily: true}, ok), ghosttyMonoFamily, symbolsMonoFamily)
	eq(chooseFamilies(nil, map[string]bool{ghosttyMonoFamily: true, ghosttySymbolsFamily: true}, fail), ghosttyMonoFamily, ghosttySymbolsFamily)
	eq(chooseFamilies([]string{"Iosevka"}, map[string]bool{"Iosevka": true}, ok), "Iosevka", ghosttySymbolsFamily)
	eq(chooseFamilies([]string{"Missing"}, nil, ok), ghosttyMonoFamily, ghosttySymbolsFamily)
	eq(chooseFamilies([]string{"Missing"}, nil, fail), "monospace")

	var asked []string
	reg := func(names []string) bool {
		asked = append(asked, names...)
		return names[0] == ghosttyMonoFiles[0]
	}
	eq(chooseFamilies(nil, nil, reg), ghosttyMonoFamily)
	if strings.Join(asked, ",") != strings.Join(append(append([]string{}, ghosttyMonoFiles...), ghosttySymbolFiles...), ",") {
		t.Errorf("registered %q", asked)
	}
}

func TestApplyGhosttyFont(t *testing.T) {
	var o terminal.Options
	var families []string
	readGhosttyConfig(strings.NewReader(`
# font-family = Ignored
font-family = Iosevka
font-family =
font-family = "JetBrains Mono"
font-size = 14
font-feature = -calt
font-thicken = true
font-thicken = false
`), &o, &families)
	if len(families) != 1 || families[0] != "JetBrains Mono" {
		t.Errorf("families %v", families)
	}
	if o.Font.Size != 14 || len(o.Font.Features) != 1 || o.Font.Features[0] != "-calt" || o.Font.Thicken {
		t.Errorf("font %+v", o.Font)
	}
	applyGhostty(&o, &families, "font-thicken", "true")
	if !o.Font.Thicken {
		t.Error("font-thicken stayed off")
	}
}

func TestEmbeddedFontFiles(t *testing.T) {
	names := append(append([]string{}, ghosttyMonoFiles...), "fonts/SymbolsNerdFont-Regular.ttf")
	for _, name := range names {
		b, err := fs.ReadFile(ghosttyFonts, name)
		if err != nil {
			t.Fatal(err)
		}
		if len(b) < 12 || string(b[:4]) != "\x00\x01\x00\x00" {
			t.Errorf("%s is not a TrueType font (%d bytes)", name, len(b))
		}
	}
}
