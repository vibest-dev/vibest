package ghostty

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/egoist/mygo/plugins/terminal"
)

func Look() terminal.Options {
	var o terminal.Options
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		dir = filepath.Join(os.Getenv("HOME"), ".config")
	}
	var families []string
	for _, path := range []string{
		filepath.Join(dir, "ghostty", "config"),
		filepath.Join(os.Getenv("HOME"), "Library", "Application Support", "com.mitchellh.ghostty", "config"),
	} {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		readGhosttyConfig(f, &o, &families)
		f.Close()
	}
	o.Font.Family = resolveFamilies(families)
	return o
}

func readGhosttyConfig(r io.Reader, o *terminal.Options, families *[]string) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		key, value, ok := strings.Cut(sc.Text(), "=")
		if !ok || strings.HasPrefix(strings.TrimSpace(key), "#") {
			continue
		}
		applyGhostty(o, families, strings.TrimSpace(key), strings.Trim(strings.TrimSpace(value), `"`))
	}
}

func applyGhostty(o *terminal.Options, families *[]string, key, value string) {
	switch key {
	case "font-family":
		if value == "" {
			*families = nil
		} else {
			*families = append(*families, value)
		}
	case "font-size":
		if n, err := strconv.ParseFloat(value, 32); err == nil {
			o.Font.Size = float32(n)
		}
	case "font-feature":
		o.Font.Features = append(o.Font.Features, value)
	case "font-thicken":
		switch value {
		case "true":
			o.Font.Thicken = true
		case "false":
			o.Font.Thicken = false
		}
	case "theme":
		o.Theme, o.DarkTheme = ghosttyThemes(value)
	}
}

func ghosttyThemes(value string) (light, dark *terminal.Theme) {
	if !strings.Contains(value, ":") {
		th, _ := terminal.GhosttyTheme(value)
		return th, nil
	}
	for _, part := range strings.Split(value, ",") {
		mode, name, _ := strings.Cut(part, ":")
		th, err := terminal.GhosttyTheme(strings.TrimSpace(name))
		if err != nil {
			continue
		}
		switch strings.TrimSpace(mode) {
		case "light":
			light = th
		case "dark":
			dark = th
		}
	}
	return light, dark
}
