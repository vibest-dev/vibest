package core_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"

	"vibest-desktop/internal/core"
)

func connectWith(t *testing.T, reply map[string]any) (map[string]any, error) {
	t.Helper()
	a, b := net.Pipe()
	sent := make(chan map[string]any, 1)
	go func() {
		line, err := bufio.NewReader(b).ReadBytes('\n')
		if err != nil {
			return
		}
		var h struct {
			ID     uint64         `json:"id"`
			Params map[string]any `json:"params"`
		}
		json.Unmarshal(line, &h)
		sent <- h.Params
		reply["jsonrpc"], reply["id"] = "2.0", h.ID
		out, _ := json.Marshal(reply)
		b.Write(append(out, '\n'))
	}()
	c, err := core.Connect(context.Background(), a)
	b.Close()
	if c != nil {
		c.Close()
	}
	return <-sent, err
}

func TestHelloAcceptsAnyVersionWithThePinnedGeneration(t *testing.T) {
	params, err := connectWith(t, map[string]any{"result": map[string]any{
		"generation": core.PinnedGeneration, "version": "0.2.0", "framed": true,
		"core":     map[string]string{"id": "c", "name": "n"},
		"methods":  []string{"terminal.run", "terminal.get", "terminal.attach", "terminal.kill", "events.subscribe", "doc.get", "doc.set", "machine.list"},
		"features": []string{"framed", "attach", "events", "status", "shell"},
	}})
	if params["generation"] != float64(core.PinnedGeneration) || params["framed"] != true {
		t.Fatalf("hello sent %v", params)
	}
	if err != nil {
		t.Fatalf("a core with the pinned generation was refused: %v", err)
	}
}

func TestHelloRefusesAnotherProtocolGeneration(t *testing.T) {
	_, err := connectWith(t, map[string]any{"result": map[string]any{
		"generation": core.PinnedGeneration + 1, "version": core.PinnedVersion, "framed": true,
		"core": map[string]string{"id": "c", "name": "n"}, "methods": []string{}, "features": []string{},
	}})
	var mismatch *core.Mismatch
	if !errors.As(err, &mismatch) || !strings.Contains(err.Error(), fmt.Sprintf("speaks protocol generation %d; this app needs generation %d", core.PinnedGeneration+1, core.PinnedGeneration)) {
		t.Fatalf("generation mismatch: %v", err)
	}
	_, err = connectWith(t, map[string]any{"error": map[string]any{"code": -32000, "message": "unsupported_generation", "data": map[string]string{"kind": "unsupported_generation"}}})
	if !errors.As(err, &mismatch) || !strings.Contains(err.Error(), "refused protocol generation 1") {
		t.Fatalf("generation refusal: %v", err)
	}
}
