package herdr

import (
	"encoding/json"
	"path"
	"strings"
	"unicode"
)

type PaneState int

const (
	PaneUnknown PaneState = iota
	PaneIdle
	PaneBusy
)

type PaneProcess struct {
	State PaneState
	Name  string
}

func ProcessInfoArgs(machine, pane string) []string {
	args := []string{"pane", "process-info", "--pane", pane}
	if machine != "" {
		args = append([]string{"--machine", machine}, args...)
	}
	return args
}

func ParsePaneProcess(stdout []byte, err error) PaneProcess {
	if err != nil {
		return PaneProcess{}
	}
	var res struct {
		Result struct {
			Info *struct {
				ShellPID  *uint32 `json:"shell_pid"`
				GroupID   *uint32 `json:"foreground_process_group_id"`
				Processes []struct {
					PID   uint32 `json:"pid"`
					Name  string `json:"name"`
					Argv0 string `json:"argv0"`
				} `json:"foreground_processes"`
			} `json:"process_info"`
		} `json:"result"`
	}
	if json.Unmarshal(stdout, &res) != nil {
		return PaneProcess{}
	}
	info := res.Result.Info
	if info == nil || info.ShellPID == nil || info.GroupID == nil || len(info.Processes) == 0 {
		return PaneProcess{}
	}
	shell, group := *info.ShellPID, *info.GroupID
	idle := group == shell
	for _, p := range info.Processes {
		if p.PID != shell || !isShell(p.Name) && !isShell(p.Argv0) {
			idle = false
		}
	}
	if idle {
		return PaneProcess{State: PaneIdle}
	}
	pick, other := info.Processes[0], false
	for _, p := range info.Processes {
		if p.PID != shell && (!other || p.PID == group) {
			pick, other = p, true
		}
	}
	name := pick.Argv0
	if name == "" {
		name = pick.Name
	}
	return PaneProcess{State: PaneBusy, Name: shortName(name)}
}

func isShell(name string) bool {
	switch strings.ToLower(strings.TrimSuffix(strings.TrimLeft(path.Base(strings.ReplaceAll(name, `\`, "/")), "-"), ".exe")) {
	case "sh", "bash", "dash", "zsh", "fish", "ksh", "mksh", "csh", "tcsh", "elvish", "xonsh", "nu", "pwsh", "powershell", "cmd":
		return true
	}
	return false
}

func shortName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, path.Base(name))
	if r := []rune(name); len(r) > 40 {
		name = string(r[:40])
	}
	if name == "" || name == "." || name == "/" {
		return "a program"
	}
	return name
}
