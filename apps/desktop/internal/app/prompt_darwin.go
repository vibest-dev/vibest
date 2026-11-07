//go:build darwin

package app

import (
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

const nsAlertFirstButtonReturn = 1000

type nsRect struct {
	X, Y, W, H float64
}

var (
	appKitOnce  sync.Once
	msgInitRect func(objc.ID, objc.SEL, nsRect) objc.ID
)

func loadAppKit() {
	appKitOnce.Do(func() {
		for _, path := range []string{
			"/System/Library/Frameworks/Foundation.framework/Foundation",
			"/System/Library/Frameworks/AppKit.framework/AppKit",
		} {
			if _, err := purego.Dlopen(path, purego.RTLD_GLOBAL|purego.RTLD_NOW); err != nil {
				panic(err)
			}
		}
		addr, err := purego.Dlsym(purego.RTLD_DEFAULT, "objc_msgSend")
		if err != nil {
			panic(err)
		}
		purego.RegisterFunc(&msgInitRect, addr)
	})
}

func sel(name string) objc.SEL { return objc.RegisterName(name) }

func nsString(s string) objc.ID {
	b := append([]byte(s), 0)
	id := objc.ID(objc.GetClass("NSString")).Send(sel("stringWithUTF8String:"), unsafe.Pointer(&b[0]))
	runtime.KeepAlive(b)
	return id
}

func (a *App) ask(title, value string, confirm bool, run func(string)) {
	win := a.macWin
	if win == nil {
		a.askInWindow(title, value, confirm, run)
		return
	}
	d := &dialog{run: run}
	a.beginNativeDialog(d)
	go func() {
		var (
			text string
			ok   bool
		)
		if confirm {
			res, err := mygo.Dialog.Message(mygo.MessageOptions{
				Parent:       win,
				Type:         mygo.MessageWarning,
				Message:      title,
				Buttons:      []string{"Close", "Cancel"},
				CancelButton: 1,
			})
			ok = err == nil && res.Button == 0
		} else {
			text, ok = macPrompt(title, value)
		}
		a.mu.Lock()
		a.finishNativeDialog(d, ok, text)
		a.mu.Unlock()
		if a.invalidate != nil {
			a.invalidate()
		}
	}()
}

func (a *App) confirm(title, detail, action string, run, cancel func()) {
	win := a.macWin
	if win == nil {
		a.confirmInWindow(title, detail, action, run, cancel)
		return
	}
	d := &dialog{run: func(string) { run() }, cancel: cancel}
	a.beginNativeDialog(d)
	go func() {
		res, err := mygo.Dialog.Message(mygo.MessageOptions{
			Parent:        win,
			Type:          mygo.MessageWarning,
			Message:       title,
			Detail:        detail,
			Buttons:       []string{"Cancel", action},
			DefaultButton: -1,
			CancelButton:  0,
		})
		a.mu.Lock()
		a.finishNativeDialog(d, err == nil && res.Button == 1, "")
		a.mu.Unlock()
		a.invalidate()
	}()
}

func macPrompt(title, value string) (string, bool) {
	var (
		text string
		ok   bool
	)
	mygo.RunOnMain(func() {
		loadAppKit()
		alert := objc.ID(objc.GetClass("NSAlert")).Send(sel("alloc")).Send(sel("init"))
		defer alert.Send(sel("release"))
		alert.Send(sel("setAlertStyle:"), uintptr(1))
		alert.Send(sel("setMessageText:"), nsString(title))
		alert.Send(sel("addButtonWithTitle:"), nsString("OK"))
		alert.Send(sel("addButtonWithTitle:"), nsString("Cancel"))
		field := objc.ID(objc.GetClass("NSTextField")).Send(sel("alloc"))
		field = msgInitRect(field, sel("initWithFrame:"), nsRect{W: 280, H: 24})
		field.Send(sel("setStringValue:"), nsString(value))
		alert.Send(sel("setAccessoryView:"), field)
		field.Send(sel("release"))
		alert.Send(sel("window")).Send(sel("setInitialFirstResponder:"), field)
		buttons := alert.Send(sel("buttons"))
		buttons.Send(sel("objectAtIndex:"), 0).Send(sel("setKeyEquivalent:"), nsString("\r"))
		buttons.Send(sel("objectAtIndex:"), 1).Send(sel("setKeyEquivalent:"), nsString("\x1b"))
		app := objc.ID(objc.GetClass("NSApplication")).Send(sel("sharedApplication"))
		app.Send(sel("activateIgnoringOtherApps:"), uintptr(1))
		if objc.Send[int](alert, sel("runModal")) != nsAlertFirstButtonReturn {
			return
		}
		if str := field.Send(sel("stringValue")); str != 0 {
			text = objc.Send[string](str, sel("UTF8String"))
		}
		ok = true
	})
	return text, ok
}

func (a *App) pickFolder(start string, run func(string)) bool {
	win := a.macWin
	if win == nil {
		return false
	}
	d := &dialog{run: run}
	a.beginNativeDialog(d)
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: win, Title: "Choose Project folder", ButtonLabel: "Choose", Directory: true, DefaultPath: start, CreateDirectories: true})
		a.mu.Lock()
		dir := ""
		if len(paths) > 0 {
			dir = paths[0]
		}
		a.finishNativeDialog(d, err == nil && dir != "", dir)
		a.mu.Unlock()
		if a.invalidate != nil {
			a.invalidate()
		}
	}()
	return true
}
