package app

import (
	"context"
	"time"

	"github.com/egoist/mygo/ui"
	"vibest-desktop/internal/chrome"
	"vibest-desktop/internal/vibest"
)

func (a *App) harnessPlaceholderProject() (vibest.Project, bool) {
	p, ok := a.vibestModel.Projects[a.currentProject()]
	if !ok || p.EntrySessionID != nil {
		return vibest.Project{}, false
	}
	if a.emptyProject == p.ID || a.pickingHarness == p.ID {
		return p, true
	}
	return vibest.Project{}, false
}

func (a *App) harnessPlaceholder(c *ui.Context, p vibest.Project) {
	th := a.th
	ui.Column(c).Grow(1).FillWidth().Padding(chrome.Step8).Gap(chrome.Step8).Label("harness-placeholder").Children(func() {
		ui.Text(c, "Start the main agent").FontSize(th.FontSize).FontWeight(600).TextColor(th.Foreground)
		ui.Text(c, p.Name()).FontSize(th.FontSizeSmall).TextColor(th.Secondary)
		if directory(p) == "" {
			ui.Text(c, "This project has no folder, so its main agent cannot be started.").TextColor(th.Secondary).MaxWidth(460)
			return
		}
		a.ensureHarnessCatalog()
		if a.harnessNote != "" {
			ui.Text(c, a.harnessNote).TextColor(th.Danger).MaxWidth(460)
			if ui.Button(c, "Retry harness list").Clicked() {
				a.harnessAsked = false
				a.harnessNote = ""
				a.harnessChoices = nil
			}
		}
		if a.harnessLoading && len(a.harnessChoices) == 0 {
			ui.Text(c, "Loading harnesses").TextColor(th.Secondary)
		}
		for _, h := range a.harnessChoices {
			a.harnessChoice(c, p, h)
		}
		if a.pickingHarness == p.ID && a.emptyProject != p.ID && ui.Button(c, "Show terminals").Clicked() {
			a.pickingHarness = ""
		}
	})
}

func (a *App) harnessChoice(c *ui.Context, p vibest.Project, h vibest.HarnessChoice) {
	th := a.th
	name := ui.Text(c, h.Harness).FontWeight(600).Label("harness: " + h.Harness)
	if h.Problem != nil {
		name.TextColor(th.Secondary)
		ui.Text(c, *h.Problem).FontSize(th.FontSizeSmall).TextColor(th.Secondary).Label("harness problem: " + h.Harness).MaxWidth(460)
		return
	}
	name.TextColor(th.Foreground)
	for _, group := range providerGroups(h.Models) {
		title := group.provider
		if title == "" {
			title = "Default"
		}
		ui.Text(c, title).FontSize(th.FontSizeSmall).TextColor(th.Secondary).Label("provider: " + h.Harness + "/" + title)
		for _, m := range group.models {
			key := modelKey(m)
			on := a.harnessPick[h.Harness] == key
			label := "model: " + h.Harness + "/" + m.Model
			if on {
				label = "selected model: " + h.Harness + "/" + m.Model
			}
			text := m.Name
			if text == "" {
				text = m.Model
			}
			b := ui.Button(c.Key("model/"+h.Harness+"/"+key), text).Label(label)
			if b.Clicked() {
				if a.harnessPick == nil {
					a.harnessPick = map[string]string{}
				}
				a.harnessPick[h.Harness] = key
			}
		}
	}
	if ui.PrimaryButton(c.Key("start/"+h.Harness), "Start "+h.Harness).Clicked() {
		a.launchHarness(p, h)
	}
}

func (a *App) launchHarness(p vibest.Project, h vibest.HarnessChoice) {
	argv := append([]string{}, a.vibestCommand...)
	if len(argv) == 0 {
		argv = []string{"vibest"}
	}
	argv = append(argv, "--harness", h.Harness)
	if key := a.harnessPick[h.Harness]; key != "" {
		for _, m := range h.Models {
			if modelKey(m) != key {
				continue
			}
			if m.Provider != nil && *m.Provider != "" {
				argv = append(argv, "--provider", *m.Provider)
			}
			argv = append(argv, "--model", m.Model)
			break
		}
	}
	runtime := "hc"
	dir := directory(p)
	a.pickingHarness = ""
	a.vibestDo(func(ctx context.Context, c *vibest.Client) error {
		_, err := c.Launch(ctx, dir, vibest.LaunchParams{Argv: argv, Runtime: &runtime})
		return err
	})
}

func (a *App) ensureHarnessCatalog() {
	if a.harnessAsked || a.harnessLoading {
		return
	}
	a.harnessAsked = true
	a.harnessLoading = true
	socket, dial := a.vibestSocket, a.dialVibest
	if socket == "" || dial == nil {
		a.harnessLoading = false
		a.harnessNote = "vibestd is not configured"
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		var list []vibest.HarnessChoice
		c, err := dial(ctx, socket)
		if err == nil {
			defer c.Close()
			list, err = c.Harnesses(ctx)
		}
		a.mu.Lock()
		a.harnessLoading = false
		if err != nil {
			a.harnessNote = vibestMessage(err)
		} else {
			a.harnessChoices = list
			a.harnessNote = ""
			if a.harnessPick == nil {
				a.harnessPick = map[string]string{}
			}
			for _, h := range list {
				if _, ok := a.harnessPick[h.Harness]; ok {
					continue
				}
				for _, m := range h.Models {
					if m.Default {
						a.harnessPick[h.Harness] = modelKey(m)
						break
					}
				}
			}
		}
		a.mu.Unlock()
		a.invalidate()
	}()
}

type harnessProviderGroup struct {
	provider string
	models   []vibest.HarnessModel
}

func providerGroups(models []vibest.HarnessModel) []harnessProviderGroup {
	var out []harnessProviderGroup
	index := map[string]int{}
	for _, m := range models {
		provider := ""
		if m.Provider != nil {
			provider = *m.Provider
		}
		i, ok := index[provider]
		if !ok {
			index[provider] = len(out)
			out = append(out, harnessProviderGroup{provider: provider})
			i = len(out) - 1
		}
		out[i].models = append(out[i].models, m)
	}
	return out
}

func modelKey(m vibest.HarnessModel) string {
	provider := ""
	if m.Provider != nil {
		provider = *m.Provider
	}
	return provider + "\x00" + m.Model
}
