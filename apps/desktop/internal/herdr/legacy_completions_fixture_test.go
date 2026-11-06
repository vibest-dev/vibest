package herdr

import (
	"encoding/json"
	"errors"
)

const completionsKind = "endpoint.agent-completions.v1"

type agentCompletions struct {
	boot     string
	revision uint64
	tokens   map[string]uint64
}

func (s *Shell) takeCompletions(data string) error {
	var projection struct {
		Boot        string             `json:"boot_id"`
		Revision    *uint64            `json:"revision"`
		Completions map[string]*uint64 `json:"completions"`
	}
	if err := json.Unmarshal([]byte(data), &projection); err != nil {
		return err
	}
	if projection.Boot == "" || projection.Revision == nil || projection.Completions == nil {
		return errors.New("herdr: incomplete agent completions projection")
	}
	tokens := make(map[string]uint64, len(projection.Completions))
	for pane, seq := range projection.Completions {
		if seq == nil {
			return errors.New("herdr: null agent completion token")
		}
		tokens[pane] = *seq
	}
	s.mu.Lock()
	late := s.snap != nil && projection.Boot == s.snap.Boot && *projection.Revision <= s.snap.Revision
	s.mu.Unlock()
	if !late {
		s.completions = &agentCompletions{boot: projection.Boot, revision: *projection.Revision, tokens: tokens}
	}
	return nil
}
