package app

import "github.com/egoist/mygo/ui"

func (a *App) askInWindow(title, value string, confirm bool, run func(string)) {
	a.openDialog(&dialog{title: title, value: value, confirm: confirm, open: true, run: run})
}

func (a *App) confirmInWindow(title, detail, action string, run, cancel func()) {
	a.openDialog(&dialog{title: title, detail: detail, confirm: true, action: action, safe: true, open: true, run: func(string) { run() }, cancel: cancel})
}

func (a *App) openDialog(d *dialog) {
	a.coreSelect(nil)
	a.cancelNavigation()
	if old := a.nativeDialog; old != nil {
		a.nativeDialog = nil
		if old.cancel != nil {
			old.cancel()
		}
	}
	if old := a.dialog; old != nil && old.cancel != nil {
		old.cancel()
	}
	a.dialog = d
	a.returnFocus = false
}

func (a *App) beginNativeDialog(d *dialog) {
	a.openDialog(d)
	a.dialog = nil
	a.nativeDialog = d
	d.generation = a.navigationGeneration
}

func (a *App) finishNativeDialog(d *dialog, ok bool, value string) {
	if a.nativeDialog != d {
		return
	}
	a.nativeDialog = nil
	if a.windowClosed || a.navigationGeneration != d.generation {
		if d.cancel != nil {
			d.cancel()
		}
		return
	}
	if ok {
		d.run(value)
	} else if d.cancel != nil {
		d.cancel()
	}
	if !a.windowClosed && a.nativeDialog == nil && a.dialog == nil && a.navigationGeneration == d.generation {
		a.resumeNavigationInput()
		a.returnFocus = true
	}
}

func (a *App) dialogView(c *ui.Context) {
	d := a.dialog
	if d == nil {
		return
	}
	done := false
	ui.Modal(c.Key(d), &d.open, func() {
		ui.Column(c).Width(360).Padding(16).Gap(12).Children(func() {
			ui.Text(c, d.title).Bold()
			if d.detail != "" {
				ui.Text(c, d.detail)
			}
			if !d.confirm {
				if ui.TextInput(c, &d.value).Label(d.title).Submitted() {
					done = true
				}
			}
			ui.Row(c).Gap(8).Children(func() {
				ui.Spacer(c)
				if ui.Button(c, "Cancel").Clicked() {
					d.open = false
				}
				ok := "OK"
				if d.confirm {
					ok = d.action
				}
				button := ui.PrimaryButton
				if d.safe {
					button = ui.Button
				}
				if button(c, ok).Clicked() {
					done = true
				}
			})
		})
	})
	if done || !d.open {
		if a.dialog == d {
			a.dialog = nil
		}
		if done {
			d.run(d.value)
			d.open = false
		} else if d.cancel != nil {
			d.cancel()
		}
		if a.dialog == nil {
			a.resumeNavigationInput()
			a.returnFocus = true
		}
		c.Invalidate()
	}
}
