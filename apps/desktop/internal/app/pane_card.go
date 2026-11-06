package app

import (
	"math"
	"path"
	"vibest-desktop/internal/presentation"

	"vibest-desktop/internal/chrome"
)

const (
	headButtonSize = chrome.Step20
	headGap        = chrome.Step4
	headPad        = chrome.Step4
	headH          = headPad + headButtonSize + headPad
	sides          = float32(6)
	termBottom     = float32(4)
)

func sidePad(scale float32) float32 {
	if scale <= 0 {
		return sides
	}
	return float32(math.Ceil(float64(sides*scale)-0.01)) / scale
}

func gridLine(scale float32) float32 {
	if scale <= 0 {
		return 1
	}
	return max(1, float32(math.Floor(float64(scale)))) / scale
}

func paneTitle(snap *presentation.Snapshot, id string) string {
	if snap == nil {
		return "Terminal"
	}
	var label, cwd string
	for _, p := range snap.Panes {
		if p.ID == id {
			label, cwd = p.Label, p.Cwd
		}
	}
	for _, ag := range snap.Agents {
		if ag.PaneID != id {
			continue
		}
		if label != "" {
			break
		}
		label = ag.Display
		if label == "" {
			label = ag.Name
		}
		if ag.Title != "" {
			if label != "" {
				label += " · "
			}
			label += ag.Title
		}
	}
	if label == "" && cwd != "" {
		label = path.Base(cwd)
	}
	if label == "" || label == "." || label == "/" {
		label = "Terminal"
	}
	return label
}
