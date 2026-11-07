package app

import (
	"encoding/json"
	"testing"

	"vibest-desktop/internal/vibest"
	"vibest-desktop/internal/vibest/vibestfake"
)

func useVibest(a *App, path string) {
	a.mu.Lock()
	a.vibestSocket = path
	a.vibestNote = "previous failure"
	a.mu.Unlock()
}

func TestStartMainAgentLaunchesInHcOnlyWhenNoneRuns(t *testing.T) {
	a, _, tt := coreActivityUI(t)
	server := vibestfake.Serve(t, vibestfake.Script{
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"Launch","params":{"argv":["vibest"],"focus":false,"runtime":"hc"},"headers":[["vibest-protocol","5"],["vibest-caller","cli"],["vibest-repository","/code/Shipping"]]}`),
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"runtime":"hc","terminal":"t7","place":"herdr-core terminal t7","attach":null}}`),
	}, vibestfake.Script{
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"Launch","params":{"argv":["vibest"],"focus":false,"runtime":"hc"},"headers":[["vibest-protocol","5"],["vibest-caller","cli"],["vibest-repository","/code/Shipping"]]}`),
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"error":{"_tag":"Cause","code":0,"message":"no runtime hc","data":[{"_tag":"Fail","error":{"_tag":"RuntimeUnavailable","message":"runtime hc is offline"}}]}}`),
	})
	useVibest(a, server.Path)
	applyVibest(a, shippingSnapshot())
	tt.Frame()
	if err := tt.RightClick("project: Shipping"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Start main agent"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return a.vibestNote == "" })
	if err := tt.RightClick("project: Shipping"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Start main agent"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return a.vibestNote != "" })
	tt.Frame()
	if !tt.HasText("vibest: runtime hc is offline") {
		t.Fatalf("launch failure not shown: %v", tt.Texts())
	}
	applyVibest(a, vibest.Event{Tag: "Session", Session: ptrTo(vibestSession("main", "lead", "p1", "idle", "a", nil, 1))})
	tt.Frame()
	if err := tt.RightClick("project: Shipping"); err != nil {
		t.Fatal(err)
	}
	if err := tt.ChooseMenuItem("Start main agent"); err == nil {
		t.Fatal("start enabled while the main agent runs")
	}
	tt.CloseMenu()
}

func TestArchiveAsksFirstThenRemovesAndShowsFailures(t *testing.T) {
	a, _, tt := coreActivityUI(t)
	recorded := vibestfake.Load(t, "remove.ndjson")
	server := vibestfake.Serve(t, recorded[:2], recorded[2:4])
	useVibest(a, server.Path)
	applyVibest(a, shippingSnapshot(
		vibestSession("00000000-0000-4000-8000-000000000001", "worker", "p1", "idle", "a", nil, 1),
		vibestSession("0000000000", "ghost", "p1", "idle", "b", nil, 2),
	))
	tt.Frame()
	openShipping(t, a, tt)
	archive := func(name string) {
		t.Helper()
		if err := tt.RightClick("session: " + name); err != nil {
			t.Fatal(err)
		}
		if err := tt.ChooseMenuItem("Archive…"); err != nil {
			t.Fatal(err)
		}
		tt.Frame()
		if !tt.HasText("Archive " + name + "?") {
			t.Fatalf("no confirmation: %v", tt.Texts())
		}
	}
	archive("worker")
	if err := tt.Click("Cancel"); err != nil {
		t.Fatal(err)
	}
	tt.Frame()
	archive("worker")
	if err := tt.Click("Archive"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return a.vibestNote == "" && a.dialog == nil })
	archive("ghost")
	if err := tt.Click("Archive"); err != nil {
		t.Fatal(err)
	}
	awaitCoreApp(t, a, func() bool { return a.vibestNote != "" })
	tt.Frame()
	if !tt.HasText("vibest: no session 0000000000") {
		t.Fatalf("remove failure not shown: %v", tt.Texts())
	}
}

func TestStopEndsTheMainAgentThroughStopCoordinator(t *testing.T) {
	a, _, tt := coreActivityUI(t)
	request := json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"Project.StopCoordinator","params":{"runtime":"hc","address":"{\"machine\":\"local\",\"id\":\"a\"}"},"headers":[["vibest-protocol","5"],["vibest-caller","cli"],["vibest-repository","/code/Shipping"]]}`)
	server := vibestfake.Serve(t, vibestfake.Script{
		request,
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"result":"stopped"}}`),
	}, vibestfake.Script{
		request,
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"result":"unsupported","reason":"vibest update is restarting it there"}}`),
	})
	useVibest(a, server.Path)
	applyVibest(a, shippingSnapshot(vibestSession("main", "lead", "p1", "idle", "a", nil, 1)))
	tt.Frame()
	openShipping(t, a, tt)
	stop := func() {
		t.Helper()
		if err := tt.RightClick("session: lead"); err != nil {
			t.Fatal(err)
		}
		if err := tt.ChooseMenuItem("Stop…"); err != nil {
			t.Fatalf("%v: %v", err, tt.Menu())
		}
		tt.Frame()
		if err := tt.Click("Stop"); err != nil {
			t.Fatal(err)
		}
	}
	stop()
	awaitCoreApp(t, a, func() bool { return a.vibestNote == "" && a.dialog == nil })
	stop()
	awaitCoreApp(t, a, func() bool { return a.vibestNote != "" })
	tt.Frame()
	if !tt.HasText("vibestd: vibest update is restarting it there") {
		t.Fatalf("stop failure not shown: %v", tt.Texts())
	}
}

func ptrTo[T any](v T) *T { return &v }
