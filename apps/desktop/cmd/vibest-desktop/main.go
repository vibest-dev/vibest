package main

import (
	"context"
	"flag"
	"log"
	"runtime"

	"vibest-desktop/internal/app"
	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/core"
	"vibest-desktop/internal/ghostty"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func main() {
	session := flag.String("core-session", "", "Core session (default: HC_SESSION or default)")
	socket := flag.String("core-socket", "", "explicit Core Unix socket (default: HC_SOCKET or Core path rules)")
	hc := flag.String("hc", "", "herdr-core binary to use (default: found like herdr-app finds it)")
	flag.Parse()

	core.FillPathFromLoginShell()
	endpoint, err := core.EndpointFromEnv(*session, *socket)
	if err != nil {
		log.Fatal(err)
	}
	client := app.NewApp(endpoint)
	client.SetCoreDialer(core.HC{Finder: core.FinderFromEnv(*hc), Session: *session, Socket: *socket}.Dial)
	client.SetLook(ghostty.Look())
	config := chrome.ConfigDir()
	client.LoadThemes(config)
	if runtime.GOOS == "darwin" {
		mygo.App.SetMenu(app.MenuBar())
	}
	mygo.App.SetWindowStateStore(chrome.WindowStates{Dir: chrome.StateDir(), Legacy: config})
	mygo.App.WhenReady(func() {
		var trafficLights *mygo.Point
		if runtime.GOOS == "darwin" {
			trafficLights = client.TrafficLights()
		}
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:                "Vibest",
			Width:                1280,
			Height:               800,
			StateKey:             "main",
			TitleBarStyle:        mygo.TitleBarHidden,
			TrafficLightPosition: trafficLights,
			Content:              ui.View(client.View),
		})
		client.Attach(app.Host{
			Window:     win,
			Invalidate: win.Invalidate,
			SetTitle: func(t string) {
				if t == "" {
					t = "Vibest"
				}
				win.SetTitle(t)
			},
			Bell: func() {
				if !win.IsFocused() {
					mygo.App.Dock.Bounce(false)
				}
			},
			Notify: func(paneID, title, body string) {
				mygo.NewNotification(mygo.NotificationOptions{ID: paneID, Title: title, Body: body}).Show()
			},
			SetAppearance: func(s string) { mygo.Theme.SetSource(mygo.ThemeSource(s)) },
			SetMenu:       mygo.App.SetMenu,
			SetWindowDark: func(dark bool) { app.SetWindowDark(win, dark) },
			SetVibrancy: func(on bool) {
				material := mygo.VibrancyNone
				if on && !mygo.Theme.Preferences().ReduceTransparency {
					material = mygo.VibrancyUnderWindow
				}
				win.SetVibrancy(material)
			},
		})
		win.OnFocus(func() { client.Focus(true) })
		win.OnBlur(func() { client.Focus(false) })
		mygo.App.OnNotificationClick(func(id string) {
			win.Focus()
			client.ShowNotice(id)
		})
		app.StartDebug(client, win)
		ctx, cancel := context.WithCancel(context.Background())
		win.OnClosed(func() { client.WindowClosed(); cancel() })
		go client.Run(ctx)
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
