package vibest

import (
	"context"
	"encoding/json"
	"fmt"
)

type RuntimeStatus struct {
	Kind   string  `json:"kind"`
	Status string  `json:"status"`
	Reason *string `json:"reason,omitempty"`
}

type PingResult struct {
	Protocol     *int            `json:"protocol"`
	Version      string          `json:"version"`
	Runtimes     []RuntimeStatus `json:"runtimes"`
	PID          *int            `json:"pid,omitempty"`
	Instance     *string         `json:"instance,omitempty"`
	Command      []string        `json:"command,omitempty"`
	StartedAt    *float64        `json:"startedAt,omitempty"`
	Capabilities map[string]bool `json:"capabilities"`
}

type ProtocolError struct {
	Daemon  int
	Version string
}

func (e *ProtocolError) Error() string {
	if e.Daemon > Protocol {
		return fmt.Sprintf("vibestd %s speaks protocol %d, this app speaks %d: update the desktop app", e.Version, e.Daemon, Protocol)
	}
	return fmt.Sprintf("vibestd %s speaks protocol %d, this app speaks %d: run vibest update", e.Version, e.Daemon, Protocol)
}

func (c *Client) Ping(ctx context.Context) (PingResult, error) {
	var out PingResult
	if err := c.Call(ctx, "Ping", "", nil, &out); err != nil {
		return out, err
	}
	if out.Protocol == nil || *out.Protocol != Protocol {
		daemon := 0
		if out.Protocol != nil {
			daemon = *out.Protocol
		}
		return out, &ProtocolError{Daemon: daemon, Version: out.Version}
	}
	return out, nil
}

type OpenParams struct {
	Move *bool `json:"move,omitempty"`
}

type Moved struct {
	From     string   `json:"from"`
	Repaired []string `json:"repaired"`
	Manual   []string `json:"manual"`
}

type OpenResult struct {
	ProjectID  string   `json:"projectId"`
	Directory  string   `json:"directory"`
	Moved      *Moved   `json:"moved,omitempty"`
	Candidates []string `json:"candidates,omitempty"`
}

func (c *Client) OpenProject(ctx context.Context, directory string, params OpenParams) (OpenResult, error) {
	var out OpenResult
	return out, c.Call(ctx, "Project.Open", directory, params, &out)
}

type LaunchParams struct {
	Argv    []string `json:"argv"`
	Focus   bool     `json:"focus"`
	Runtime *string  `json:"runtime,omitempty"`
}

type LaunchResult struct {
	Runtime  string   `json:"runtime"`
	Terminal string   `json:"terminal"`
	Place    string   `json:"place"`
	Attach   []string `json:"attach"`
}

func (c *Client) Launch(ctx context.Context, directory string, params LaunchParams) (LaunchResult, error) {
	var out LaunchResult
	return out, c.Call(ctx, "Launch", directory, params, &out)
}

type RemoveParams struct {
	ID           string `json:"id"`
	KeepWorktree *bool  `json:"keepWorktree,omitempty"`
}

type RemoveResult struct {
	ID        string   `json:"id"`
	Processes string   `json:"processes"`
	Pane      string   `json:"pane"`
	Workspace string   `json:"workspace"`
	Worktree  string   `json:"worktree"`
	Path      string   `json:"path"`
	Branch    *string  `json:"branch"`
	Reasons   []string `json:"reasons"`
}

func (c *Client) Remove(ctx context.Context, params RemoveParams) (*RemoveResult, error) {
	var out *RemoveResult
	return out, c.Call(ctx, "Remove", "/", params, &out)
}

type Watch struct{ stream *Stream }

func (c *Client) Watch(repository string) (*Watch, error) {
	s, err := c.Stream("Watch", repository, nil)
	if err != nil {
		return nil, err
	}
	return &Watch{stream: s}, nil
}

func (w *Watch) Next(ctx context.Context) ([]Event, error) {
	chunk, err := w.stream.Next(ctx)
	if err != nil {
		return nil, err
	}
	events := make([]Event, 0, len(chunk))
	for _, raw := range chunk {
		var e Event
		if err := json.Unmarshal(raw, &e); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, nil
}

func (w *Watch) Close() error { return w.stream.Close() }
