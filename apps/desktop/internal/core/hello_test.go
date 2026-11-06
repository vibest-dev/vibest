package core_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
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
		defer b.Close()
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
	if c != nil {
		c.Close()
	}
	return <-sent, err
}

func TestHelloRefusesACoreThatDoesNotMatchThePinnedDocument(t *testing.T) {
	params, err := connectWith(t, map[string]any{"result": map[string]any{
		"generation": core.PinnedGeneration, "version": "0.2.0", "framed": true,
		"core": map[string]string{"id": "c", "name": "n"}, "methods": []string{}, "features": []string{},
	}})
	if params["generation"] != float64(core.PinnedGeneration) || params["framed"] != true {
		t.Fatalf("hello sent %v", params)
	}
	var mismatch *core.Mismatch
	if !errors.As(err, &mismatch) || !strings.Contains(err.Error(), "herdr-core 0.2.0 (generation 1) does not match the herdr-core "+core.PinnedVersion) {
		t.Fatalf("version mismatch: %v", err)
	}
	_, err = connectWith(t, map[string]any{"error": map[string]any{"code": -32000, "message": "unsupported_generation", "data": map[string]string{"kind": "unsupported_generation"}}})
	if !errors.As(err, &mismatch) || !strings.Contains(err.Error(), "refused protocol generation 1") {
		t.Fatalf("generation refusal: %v", err)
	}
}
