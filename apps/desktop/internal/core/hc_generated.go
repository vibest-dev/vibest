package core

import "encoding/json"

const (
	PinnedVersion    = "0.1.13"
	PinnedGeneration = 1
)

type HelloParams struct {
	CallsYou   *string   `json:"calls_you,omitempty"`
	Core       *CoreInfo `json:"core,omitempty"`
	Framed     bool      `json:"framed,omitempty"`
	Generation *uint32   `json:"generation,omitempty"`
}

type TerminalRunParams struct {
	Argv          []string          `json:"argv,omitempty"`
	Caller        *string           `json:"caller,omitempty"`
	CWD           *string           `json:"cwd,omitempty"`
	DieWithParent bool              `json:"die_with_parent,omitempty"`
	Env           map[string]string `json:"env,omitempty"`
	Keep          bool              `json:"keep,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
	Line          *string           `json:"line,omitempty"`
	Name          *string           `json:"name,omitempty"`
	NoNotify      bool              `json:"no_notify,omitempty"`
	NoParent      bool              `json:"no_parent,omitempty"`
	On            *string           `json:"on,omitempty"`
	OutliveParent bool              `json:"outlive_parent,omitempty"`
	Parent        *string           `json:"parent,omitempty"`
	Rm            bool              `json:"rm,omitempty"`
	Timeout       *float64          `json:"timeout,omitempty"`
	Wait          bool              `json:"wait,omitempty"`
}

type TerminalGetParams struct {
	Caller   *string `json:"caller,omitempty"`
	Terminal string  `json:"terminal"`
}

type TerminalKillParams struct {
	Caller   *string `json:"caller,omitempty"`
	Terminal string  `json:"terminal"`
}

type TerminalLabelParams struct {
	Labels   map[string]string `json:"labels"`
	Terminal string            `json:"terminal"`
}

type TerminalAttachParams struct {
	Caller   *string `json:"caller,omitempty"`
	Cols     uint16  `json:"cols"`
	Display  Display `json:"display,omitempty"`
	History  uint    `json:"history,omitempty"`
	Observe  bool    `json:"observe,omitempty"`
	Resumed  bool    `json:"resumed,omitempty"`
	Rows     uint16  `json:"rows"`
	Terminal string  `json:"terminal"`
}

type MachineExecParams struct {
	Argv    []string          `json:"argv,omitempty"`
	CWD     *string           `json:"cwd,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Input   *string           `json:"input,omitempty"`
	Line    *string           `json:"line,omitempty"`
	On      *string           `json:"on,omitempty"`
	Timeout *float64          `json:"timeout,omitempty"`
}

type DocGetParams struct {
	Name string  `json:"name"`
	On   *string `json:"on,omitempty"`
}

type DocSetParams struct {
	Name    string          `json:"name"`
	On      *string         `json:"on,omitempty"`
	Value   json.RawMessage `json:"value"`
	Version uint64          `json:"version"`
}

type EventsSubscribeParams struct {
	ChildrenOf *string           `json:"children_of,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	Terminal   *string           `json:"terminal,omitempty"`
}

type MachineListParams struct {
}

type AttachResult struct {
	Channel  uint32   `json:"channel"`
	Terminal Terminal `json:"terminal"`
}

type CoreInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Display struct {
	BG     *string    `json:"bg"`
	Cell   *[2]uint32 `json:"cell"`
	Cursor *string    `json:"cursor"`
	FG     *string    `json:"fg"`
}

type DocGetResult struct {
	Value   json.RawMessage `json:"value"`
	Version uint64          `json:"version"`
}

type DocSetResult struct {
	Version uint64 `json:"version"`
}

type ExecResult struct {
	Code      *int32 `json:"code"`
	MS        uint64 `json:"ms"`
	Signal    *int32 `json:"signal"`
	Stderr    string `json:"stderr"`
	Stdout    string `json:"stdout"`
	TimedOut  bool   `json:"timed_out"`
	Truncated bool   `json:"truncated"`
}

type FirstMessage struct {
	Reason  *string `json:"reason"`
	Sent    bool    `json:"sent"`
	Started *bool   `json:"started"`
	Turn    *uint64 `json:"turn"`
}

type Foreground struct {
	Argv []string `json:"argv"`
	CWD  string   `json:"cwd"`
	Name string   `json:"name"`
	PID  int32    `json:"pid"`
}

type HelloResult struct {
	Core       CoreInfo `json:"core"`
	Features   []string `json:"features"`
	Framed     bool     `json:"framed"`
	Generation uint32   `json:"generation"`
	Methods    []string `json:"methods"`
	Version    string   `json:"version"`
}

type MachineListResult struct {
	Machines []MachineView `json:"machines"`
}

type MachineView struct {
	Host      string  `json:"host"`
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Session   *string `json:"session"`
	SinceMS   *uint64 `json:"since_ms"`
	State     string  `json:"state"`
	Target    string  `json:"target"`
	Temporary bool    `json:"temporary"`
	Version   string  `json:"version"`
	Via       bool    `json:"via"`
	Why       *string `json:"why"`
}

type RunResult struct {
	Terminal
	FirstMessage *FirstMessage `json:"first_message"`
	Output       *string       `json:"output"`
	Wait         *WaitResult   `json:"wait"`
}

type Status struct {
	App      string  `json:"app"`
	Kind     *string `json:"kind"`
	Msg      string  `json:"msg"`
	Progress *uint8  `json:"progress"`
	State    string  `json:"state"`
	Title    string  `json:"title"`
}

type SubscribeResult struct {
	Channel   *uint32    `json:"channel"`
	Seq       uint64     `json:"seq"`
	Terminals []Terminal `json:"terminals"`
}

type Terminal struct {
	Address       string            `json:"address"`
	Argv          []string          `json:"argv"`
	Cols          uint16            `json:"cols"`
	CreatedMS     uint64            `json:"created_ms"`
	CWD           string            `json:"cwd"`
	DieWithParent bool              `json:"die_with_parent"`
	ExitCode      *int32            `json:"exit_code"`
	FinishedMS    *uint64           `json:"finished_ms"`
	Foreground    *Foreground       `json:"foreground"`
	Identity      string            `json:"identity"`
	Keep          bool              `json:"keep"`
	Labels        map[string]string `json:"labels"`
	Name          *string           `json:"name"`
	Notify        bool              `json:"notify"`
	Parent        *string           `json:"parent"`
	PasteGapMS    *uint64           `json:"paste_gap_ms"`
	PID           *uint32           `json:"pid"`
	Reason        *string           `json:"reason"`
	Records       map[string]Status `json:"records"`
	Reported      bool              `json:"reported"`
	Rm            bool              `json:"rm"`
	Rows          uint16            `json:"rows"`
	Screen        string            `json:"screen"`
	Signal        *int32            `json:"signal"`
	State         string            `json:"state"`
	Status        *Status           `json:"status"`
	StatusMS      *uint64           `json:"status_ms"`
	Stop          *string           `json:"stop"`
	Submit        *string           `json:"submit"`
	Template      *string           `json:"template"`
	Title         string            `json:"title"`
	Turn          uint64            `json:"turn"`
}

type WaitResult struct {
	Children []WaitResult `json:"children"`
	Ended    bool         `json:"ended"`
	ExitCode *int32       `json:"exit_code"`
	From     *string      `json:"from"`
	Reason   string       `json:"reason"`
	Signal   *int32       `json:"signal"`
	Status   *string      `json:"status"`
	Terminal string       `json:"terminal"`
	Turn     uint64       `json:"turn"`
}
