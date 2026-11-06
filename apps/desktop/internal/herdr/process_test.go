package herdr

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestParsePaneProcess(t *testing.T) {
	info := func(body string) []byte {
		return []byte(`{"id":"cli:pane:process_info","result":{"type":"pane_process_info","process_info":{"pane_id":"w1:p1"` + body + `}}}`)
	}
	failed := errors.New("exit status 1")
	for _, c := range []struct {
		name   string
		stdout string
		err    error
		want   PaneProcess
	}{
		{"idle zsh", string(info(`,"shell_pid":10,"foreground_process_group_id":10,"foreground_processes":[{"pid":10,"name":"zsh"}]`)), nil, PaneProcess{State: PaneIdle}},
		{"login shell", string(info(`,"shell_pid":10,"foreground_process_group_id":10,"foreground_processes":[{"pid":10,"name":"-zsh"}]`)), nil, PaneProcess{State: PaneIdle}},
		{"shell by path", string(info(`,"shell_pid":10,"foreground_process_group_id":10,"foreground_processes":[{"pid":10,"name":"/bin/BASH"}]`)), nil, PaneProcess{State: PaneIdle}},
		{"vim", string(info(`,"shell_pid":10,"foreground_process_group_id":20,"foreground_processes":[{"pid":20,"name":"vim","argv":["vim","secret.txt"],"cmdline":"vim secret.txt","cwd":"/home"}]`)), nil, PaneProcess{State: PaneBusy, Name: "vim"}},
		{"agent at its prompt", string(info(`,"shell_pid":10,"foreground_process_group_id":20,"foreground_processes":[{"pid":20,"name":"node","argv0":"claude"},{"pid":21,"name":"rg"}]`)), nil, PaneProcess{State: PaneBusy, Name: "claude"}},
		{"program run as the pane", string(info(`,"shell_pid":10,"foreground_process_group_id":10,"foreground_processes":[{"pid":10,"name":"htop"}]`)), nil, PaneProcess{State: PaneBusy, Name: "htop"}},
		{"shell with a child in its group", string(info(`,"shell_pid":10,"foreground_process_group_id":10,"foreground_processes":[{"pid":10,"name":"zsh"},{"pid":11,"name":"sleep"}]`)), nil, PaneProcess{State: PaneBusy, Name: "sleep"}},
		{"no leader in the group", string(info(`,"shell_pid":10,"foreground_process_group_id":20,"foreground_processes":[{"pid":21,"name":"make"}]`)), nil, PaneProcess{State: PaneBusy, Name: "make"}},
		{"nameless program", string(info(`,"shell_pid":10,"foreground_process_group_id":20,"foreground_processes":[{"pid":20,"name":""}]`)), nil, PaneProcess{State: PaneBusy, Name: "a program"}},
		{"no shell pid", string(info(`,"foreground_process_group_id":10,"foreground_processes":[{"pid":10,"name":"zsh"}]`)), nil, PaneProcess{}},
		{"no process group", string(info(`,"shell_pid":10,"foreground_processes":[{"pid":10,"name":"zsh"}]`)), nil, PaneProcess{}},
		{"no processes", string(info(`,"shell_pid":10,"foreground_process_group_id":10`)), nil, PaneProcess{}},
		{"no process info", `{"id":"x","result":{"type":"ok"}}`, nil, PaneProcess{}},
		{"not json", "zsh is idle", nil, PaneProcess{}},
		{"empty", "", nil, PaneProcess{}},
		{"failed, pane_not_found among others", "", failed, PaneProcess{}},
		{"timeout with output", string(info(`,"shell_pid":10,"foreground_process_group_id":10,"foreground_processes":[{"pid":10,"name":"zsh"}]`)), errors.New("signal: killed"), PaneProcess{}},
	} {
		if got := ParsePaneProcess([]byte(c.stdout), c.err); got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestPaneProcessNameIsShortText(t *testing.T) {
	long := strings.Repeat("x", 200)
	out := []byte(`{"result":{"process_info":{"shell_pid":1,"foreground_process_group_id":2,"foreground_processes":[{"pid":2,"name":"ev\u001b[31m\u202eil\n` + long + `"}]}}}`)
	got := ParsePaneProcess(out, nil)
	if got.State != PaneBusy || strings.ContainsAny(got.Name, "\x1b\n\u202e") || len([]rune(got.Name)) > 40 {
		t.Fatalf("name %q", got.Name)
	}
}

func TestProcessInfoArgs(t *testing.T) {
	if got, want := ProcessInfoArgs("", "w1:p2"), []string{"pane", "process-info", "--pane", "w1:p2"}; !slices.Equal(got, want) {
		t.Fatalf("local: %q", got)
	}
	if got, want := ProcessInfoArgs("0123", "w1:p2"), []string{"--machine", "0123", "pane", "process-info", "--pane", "w1:p2"}; !slices.Equal(got, want) {
		t.Fatalf("remote: %q", got)
	}
}
