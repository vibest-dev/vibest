package app

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func coreLinkURL(raw, cwd string, local bool) (string, error) {
	for _, r := range raw {
		if r < 32 || r == 127 {
			return "", errors.New("link contains a control character")
		}
	}
	u, err := url.Parse(raw)
	if err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
		return raw, nil
	}
	if !local {
		return "", errors.New("remote file links are not available")
	}
	path := raw
	if err == nil && u.Scheme == "file" {
		if u.Host != "" && u.Host != "localhost" {
			return "", errors.New("non-local file authority")
		}
		path = u.Path
	} else {
		for range 2 {
			i := strings.LastIndexByte(path, ':')
			if i < 0 {
				break
			}
			n, e := strconv.Atoi(path[i+1:])
			if e != nil || n < 1 {
				break
			}
			path = path[:i]
		}
		if parsed, e := url.Parse(path); e != nil || parsed.Scheme != "" {
			return "", errors.New("unsupported link scheme")
		}
	}
	if strings.HasPrefix(path, "~/") {
		home, e := os.UserHomeDir()
		if e != nil {
			return "", e
		}
		path = filepath.Join(home, path[2:])
	}
	if !filepath.IsAbs(path) {
		if !filepath.IsAbs(cwd) {
			return "", errors.New("no reported local working directory")
		}
		path = filepath.Join(cwd, path)
	}
	return (&url.URL{Scheme: "file", Path: filepath.Clean(path)}).String(), nil
}
