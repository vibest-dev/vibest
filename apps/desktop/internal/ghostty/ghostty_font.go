package ghostty

import (
	"embed"
	"io/fs"
	"log"
	"strings"

	"github.com/egoist/mygo/ui"
)

//go:embed fonts/JetBrainsMono-Regular.ttf fonts/JetBrainsMono-Bold.ttf fonts/JetBrainsMono-Italic.ttf fonts/JetBrainsMono-BoldItalic.ttf fonts/SymbolsNerdFont-Regular.ttf
var ghosttyFonts embed.FS

const (
	ghosttyMonoFamily    = "JetBrains Mono"
	ghosttySymbolsFamily = "Symbols Nerd Font"
	symbolsMonoFamily    = "Symbols Nerd Font Mono"
)

var (
	ghosttyMonoFiles = []string{
		"fonts/JetBrainsMono-Regular.ttf",
		"fonts/JetBrainsMono-Bold.ttf",
		"fonts/JetBrainsMono-Italic.ttf",
		"fonts/JetBrainsMono-BoldItalic.ttf",
	}
	ghosttySymbolFiles = []string{"fonts/SymbolsNerdFont-Regular.ttf"}
)

func resolveFamilies(configured []string) string {
	have := map[string]bool{}
	for _, f := range ui.FontFamilies() {
		have[f.Name] = true
	}
	return strings.Join(chooseFamilies(configured, have, registerGhosttyFonts), ",")
}

func chooseFamilies(configured []string, have map[string]bool, register func([]string) bool) []string {
	var out []string
	for _, f := range configured {
		if have[f] {
			out = append(out, f)
		}
	}
	if len(out) == 0 {
		name := "monospace"
		if have[ghosttyMonoFamily] || register(ghosttyMonoFiles) {
			name = ghosttyMonoFamily
		}
		out = append(out, name)
	}
	switch {
	case have[symbolsMonoFamily]:
		out = append(out, symbolsMonoFamily)
	case have[ghosttySymbolsFamily] || register(ghosttySymbolFiles):
		out = append(out, ghosttySymbolsFamily)
	}
	return out
}

func registerGhosttyFonts(names []string) bool {
	ok := true
	for _, name := range names {
		b, err := fs.ReadFile(ghosttyFonts, name)
		if err != nil {
			log.Printf("herdr: embedded font %s: %v", name, err)
			ok = false
			continue
		}
		if err := ui.RegisterFont(b, ""); err != nil {
			log.Printf("herdr: embedded font %s: %v", name, err)
			ok = false
		}
	}
	return ok
}
