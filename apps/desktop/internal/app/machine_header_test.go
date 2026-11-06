package app

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func machineHeaderCoreApp(t *testing.T) (*App, *coreAppFixture, *ui.Tester) {
	a, f, tt := coreMachineUI(t)
	publishCoreLayout(t, a, f, func(f *coreAppFixture) {
		f.layout.Workspaces[0].Label = "local repo"
		f.layout.Workspaces[0].Repository = "/repo/.git"
		f.layout.Workspaces[1].Label = "remote repo"
		f.layout.Workspaces[1].Repository = "/repo/.git"
		f.layout.Workspaces[2].Label = "remote tree"
		f.layout.Workspaces[2].Repository = "/repo/.git"
		f.layout.Workspaces[2].Linked = true
	})
	tt.SetDark(false)
	tt.Frame()
	return a, f, tt
}
func machineHeaderApp(t *testing.T) (*App, *machine, *machine, *ui.Tester) {
	a, _, tt := machineHeaderCoreApp(t)
	return a, a.machines[0], a.machines[1], tt
}
