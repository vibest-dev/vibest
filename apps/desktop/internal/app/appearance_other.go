//go:build !darwin

package app

import "github.com/egoist/mygo"

func SetWindowDark(*mygo.Window, bool) {}
