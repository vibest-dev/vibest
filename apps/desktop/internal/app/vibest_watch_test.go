package app

import (
	"bytes"
	"encoding/json"
	"testing"

	"vibest-desktop/internal/vibest/vibestfake"
)

func watchScript(t *testing.T, chunks int) vibestfake.Script {
	recorded := vibestfake.Load(t, "watch.ndjson")
	request := json.RawMessage(bytes.Replace(recorded[0], []byte(`"/fixture/repo"`), []byte(`"/"`), 1))
	script := vibestfake.Concat(vibestfake.Load(t, "ping.ndjson"), vibestfake.Script{request})
	return append(script, recorded[1:1+2*chunks]...)
}

const (
	watchProject = "00000000-0000-4000-8000-000000000001"
	watchOther   = "00000000-0000-4000-8000-000000000004"
	watchMain    = "00000000-0000-4000-8000-000000000002"
)

func blockedLeadSnapshot() json.RawMessage {
	session := `{"id":"` + watchMain + `","name":"lead","agent":"main","harness":"pi","provider":null,"model":null,"status":"blocked","startedAt":null,"exitedAt":null,"turnState":"open","projectId":"` + watchProject + `","runtime":"hc","address":{"machine":"local","id":"a"},"worktree":"/fixture/repo","repositoryRoot":null,"git":null,"createdAt":1,"lastActive":1,"task":null,"latest":null,"parentId":null}`
	event := `{"_tag":"Snapshot","projects":[{"id":"` + watchProject + `","directory":"/fixture/repo","entrySessionId":"` + watchMain + `","activity":"blocked"}],"sessions":[` + session + `]}`
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "chunk": true, "id": 1, "result": []json.RawMessage{json.RawMessage(event)}})
	return line
}

func TestWatchFeedsTheSidebarLiveAndANewSnapshotRecoversAfterALoss(t *testing.T) {
	first := watchScript(t, 2)
	second := append(watchScript(t, 0), blockedLeadSnapshot())
	server := vibestfake.Serve(t, first, second)
	a, _, tt := coreActivityUIWith(t, func(f *coreAppFixture) { f.vibest = server.Path })
	awaitCoreApp(t, a, func() bool { _, ok := a.vibestModel.Projects[watchOther]; return ok })
	tt.Frame()
	for _, name := range []string{"project: repo", "project: other"} {
		find(t, tt, name)
	}
	absent(t, tt, "main", "do it")
	if activityDescriptions(tt)["Working"] != 1 {
		t.Fatal("live working aggregate missing")
	}
	server.DropConnections()
	awaitCoreApp(t, a, func() bool { s, ok := a.vibestModel.Sessions[watchMain]; return ok && s.Name == "lead" })
	tt.Frame()
	find(t, tt, "project: repo")
	absent(t, tt, "project: other", "do it")
	if activityDescriptions(tt)["Waiting for you"] != 1 {
		t.Fatal("reconnected waiting aggregate missing")
	}
	if err := tt.Click("project: repo"); err != nil {
		t.Fatal(err)
	}
	finishProjectOpen(t, a, tt)
	awaitCoreApp(t, a, func() bool { return a.currentProject() == watchProject && !a.corePending })
	tt.Frame()
	find(t, tt, "session: lead")
}

func TestAMissingVibestdIsShown(t *testing.T) {
	a, _, tt := coreActivityUIWith(t, func(f *coreAppFixture) { f.vibest = "/inert/no-vibest.sock" })
	awaitCoreApp(t, a, func() bool { return a.vibestNote == "vibestd is not running" })
	tt.Frame()
	if !tt.HasText("vibestd is not running") {
		t.Fatalf("%v", tt.Texts())
	}
}

func TestAVibestdWithoutWatchAsksForAnUpdateAndStops(t *testing.T) {
	server := vibestfake.Serve(t, vibestfake.Script{
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"Ping","params":null,"headers":[]}`),
		json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"protocol":5,"version":"0.0.1-old","capabilities":{"http":true}}}`),
	})
	a, _, tt := coreActivityUIWith(t, func(f *coreAppFixture) { f.vibest = server.Path })
	awaitCoreApp(t, a, func() bool { return a.vibestNote != "" })
	tt.Frame()
	if !tt.HasText("vibestd 0.0.1-old cannot stream changes: run vibest update") {
		t.Fatalf("%v", tt.Texts())
	}
}

func TestAVibestdWithoutDesktopCapabilitiesAsksForAnUpdate(t *testing.T) {
	for _, caps := range []string{`{"watch":true}`, `{"watch":true,"projects":true}`} {
		t.Run(caps, func(t *testing.T) {
			server := vibestfake.Serve(t, vibestfake.Script{
				json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"Ping","params":null,"headers":[]}`),
				json.RawMessage(`{"jsonrpc":"2.0","id":1,"result":{"protocol":5,"version":"0.0.1-old","capabilities":` + caps + `}}`),
			})
			a, _, tt := coreActivityUIWith(t, func(f *coreAppFixture) { f.vibest = server.Path })
			awaitCoreApp(t, a, func() bool { return a.vibestNote != "" })
			tt.Frame()
			if !tt.HasText("vibestd is older than this app: run vibest update") {
				t.Fatalf("%v", tt.Texts())
			}
		})
	}
}
