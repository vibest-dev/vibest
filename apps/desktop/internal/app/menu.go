package app

import (
	"runtime"

	"github.com/egoist/mygo"
)

func MenuBar(extra ...*mygo.MenuItem) *mygo.Menu {
	return menuBar(runtime.GOOS == "darwin", extra...)
}

func menuBar(mac bool, extra ...*mygo.MenuItem) *mygo.Menu {
	if !mac {
		return mygo.NewMenu(extra)
	}
	items := []*mygo.MenuItem{
		{Role: mygo.RoleAppMenu},
		{Role: mygo.RoleEditMenu},
		{Role: mygo.RoleViewMenu},
	}
	items = append(items, extra...)
	items = append(items, &mygo.MenuItem{Role: mygo.RoleWindowMenu})
	return mygo.NewMenu(items)
}
