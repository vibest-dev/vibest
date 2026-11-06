package app

func (a *App) ClosePane(pane string) { a.coreClose([]string{pane}) }
