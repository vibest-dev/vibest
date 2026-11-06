package chrome

import "github.com/egoist/mygo/ui"

func icon(body string) *ui.SVG {
	return ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">` + body + `</svg>`))
}

var (
	IconSplitRight  = icon(`<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M8 2.5v11"/>`)
	IconSplitDown   = icon(`<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M2 8h12"/>`)
	IconZoom        = icon(`<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>`)
	IconClose       = icon(`<path d="M4 4l8 8M12 4l-8 8"/>`)
	IconCheck       = icon(`<path d="M3.5 8l3 3L12.5 5"/>`)
	IconPlus        = icon(`<path d="M8 3v10M3 8h10"/>`)
	IconStart       = icon(`<path d="M5 3.5v9l7-4.5z"/>`)
	IconSidebar     = icon(`<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11"/>`)
	IconSidebarShow = icon(`<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M5 5.5v5"/>`)
	IconTheme       = icon(`<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="#000"/>`)
)
