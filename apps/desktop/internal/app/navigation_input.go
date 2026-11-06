package app

import (
	"github.com/egoist/mygo/ui"
	"time"
)

const (
	navigationTimeout = 5 * time.Second
	navigationEvents  = 1024
	navigationBytes   = 64 << 10
	navigationLost    = "Navigation input canceled; retained input was not sent"
	navigationUnsent  = "Terminal input was not sent"
	navigationPaused  = "Terminal input paused; click a pane to type"
)

func (a *App) cancelNavigation()      { a.cancelCoreCapture() }
func (a *App) resumeNavigationInput() { a.resumeCoreCapture() }
func (a *App) dropped(ev ui.InputEvent) {
	if typedInput(ev) || ev.Kind == ui.InputCompose && ev.Text != "" {
		a.unsent()
	}
}
func (a *App) unsent() {
	if a.navigationNote == "" {
		a.navigationNote = navigationUnsent
	}
}
