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
		reply = refuseOtherGeneration(h.Params, reply)
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

func refuseOtherGeneration(params, reply map[string]any) map[string]any {
	result, _ := reply["result"].(map[string]any)
	asked, has := params["generation"]
	if !has || result == nil || fmt.Sprint(asked) == fmt.Sprint(result["generation"]) {
		return reply
	}
	return map[string]any{"error": map[string]any{"code": -32000, "message": "unsupported_generation", "data": map[string]string{"kind": "unsupported_generation"}}}
}

func TestHelloAcceptsAnyVersionWithThePinnedGeneration(t *testing.T) {
	params, err := connectWith(t, map[string]any{"result": map[string]any{
		"generation": core.PinnedGeneration, "version": "0.2.0", "framed": true,
		"core":     map[string]string{"id": "c", "name": "n"},
		"methods":  []string{"terminal.run", "terminal.get", "terminal.attach", "terminal.kill", "events.subscribe", "doc.get", "doc.set", "machine.list"},
		"features": []string{"framed", "attach", "events", "status", "shell"},
	}})
	if _, has := params["generation"]; has || params["framed"] != true {
		t.Fatalf("hello sent %v", params)
	}
	if err != nil {
		t.Fatalf("a core with the pinned generation was refused: %v", err)
	}
}

func TestHelloRefusesAnotherProtocolGeneration(t *testing.T) {
	var mismatch *core.Mismatch
	for _, gen := range []uint32{core.PinnedGeneration - 1, core.PinnedGeneration + 1} {
		_, err := connectWith(t, map[string]any{"result": map[string]any{
			"generation": gen, "version": "0.3.0", "framed": true,
			"core": map[string]string{"id": "c", "name": "n"}, "methods": []string{}, "features": []string{},
		}})
		if !errors.As(err, &mismatch) || mismatch.Version != "0.3.0" || mismatch.CoreTooOld() != (gen < core.PinnedGeneration) || mismatch.CoreTooNew() != (gen > core.PinnedGeneration) ||
			!strings.Contains(err.Error(), fmt.Sprintf("herdr-core 0.3.0 speaks protocol generation %d; this app needs generation %d", gen, core.PinnedGeneration)) {
			t.Fatalf("generation %d: %v", gen, err)
		}
	}
	_, err := connectWith(t, map[string]any{"error": map[string]any{"code": -32000, "message": "unsupported_generation", "data": map[string]string{"kind": "unsupported_generation"}}})
	if !errors.As(err, &mismatch) || !strings.Contains(err.Error(), "refused protocol generation 1") {
		t.Fatalf("generation refusal: %v", err)
	}
}
