package app

import (
	"encoding/json"
	"testing"
	"time"

	"vibest-desktop/internal/vibest"
	"vibest-desktop/internal/vibest/vibestfake"
)

func TestProjectWithoutAnEntrySessionListsHarnessesAndLaunchesTheChoice(t *testing.T) {
	anthropic, openai := "anthropic", "openai"
	problem := "cursor is not on PATH"
	choices := []vibest.HarnessChoice{{
		Harness: "pi",
		Models: []vibest.HarnessModel{
			{Provider: &anthropic, Model: "sonnet", Name: "Sonnet", Default: true},
			{Provider: &anthropic, Model: "opus", Name: "Opus"},
			{Provider: &openai, Model: "gpt", Name: "GPT"},
		},
	}, {
		Harness: "cursor",
		Problem: &problem,
	}}
	listed, err := json.Marshal(choices)
	if err != nil {
		t.Fatal(err)
	}
	launch := func(model string) vibestfake.Script {
		runtime := "hc"
		return vibestfake.Script{
			vibestRequest("Launch", "/code/Shipping", vibest.LaunchParams{
				Argv:    []string{"vibest", "--harness", "pi", "--provider", "anthropic", "--model", model},
				Runtime: &runtime,
			}),
			json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"runtime":"hc","terminal":"t9","place":"hc","attach":null}}`),
		}
	}
	server := vibestfake.Serve(t,
		vibestfake.Script{
			vibestRequest("Harnesses.List", "/", nil),
			json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":` + string(listed) + `}`),
		},
		launch("sonnet"),
		launch("opus"),
	)
	a, _, tt := coreActivityUI(t)
	useVibest(a, server.Path)
	dir := "/code/Shipping"
	applyVibest(a, vibest.Event{Tag: "Snapshot", Projects: []vibest.Project{{ID: "p1", Directory: &dir}}})
	tt.Frame()
	if err := tt.RightClick("project: Shipping"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Start main agent"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		tt.Frame()
		if _, ok := tt.Find("selected model: pi/sonnet"); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("placeholder missing: %v", tt.Texts())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, ok := tt.Find("harness problem: cursor"); !ok {
		t.Fatalf("problem harness not shown: %v", tt.Texts())
	}
	if err := tt.Click("Start cursor"); err == nil {
		t.Fatal("a harness with a problem can be started")
	}
	if _, ok := tt.Find("provider: pi/openai"); !ok {
		t.Fatal("models are not grouped by provider")
	}
	if err := tt.Click("Start pi"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return a.vibestNote == "" })
	coreAppAct(a, func() { a.vibestNote = "again" })
	if err := tt.Click("model: pi/opus"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	if _, ok := tt.Find("selected model: pi/opus"); !ok {
		t.Fatalf("opus not selected: %v", tt.Texts())
	}
	if err := tt.Click("Start pi"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return a.vibestNote == "" })
}

func vibestRequest(method, repository string, params any) json.RawMessage {
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  method,
		"params":  params,
		"headers": [][2]string{{"vibest-protocol", "5"}, {"vibest-caller", "cli"}, {"vibest-repository", repository}},
	})
	if err != nil {
		panic(err)
	}
	return body
}
