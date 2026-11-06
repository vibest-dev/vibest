//go:build !darwin

package app

func (a *App) ask(title, value string, confirm bool, run func(string)) {
	a.askInWindow(title, value, confirm, run)
}

func (a *App) confirm(title, detail string, run, cancel func()) {
	a.confirmInWindow(title, detail, run, cancel)
}

func (a *App) pickFolder(string, func(string)) bool { return false }
