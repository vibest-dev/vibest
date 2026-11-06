//go:build darwin

package app

import (
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

func SetWindowDark(win *mygo.Window, dark bool) {
	h := win.NativeHandle()
	if h == 0 {
		return
	}
	name := "NSAppearanceNameAqua"
	if dark {
		name = "NSAppearanceNameDarkAqua"
	}
	mygo.RunOnMain(func() {
		loadAppKit()
		ap := objc.ID(objc.GetClass("NSAppearance")).Send(sel("appearanceNamed:"), nsString(name))
		objc.ID(h).Send(sel("setAppearance:"), ap)
	})
}
