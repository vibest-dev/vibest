import { assert, describe, it } from "@effect/vitest"

import {
  cliArgv,
  coreAddress,
  coreTerminals,
  focusOf,
  groupSessions,
  matchTerminal,
  modelPanes,
  parseDaemonRunning,
  parseSessions,
  projectHeading,
  type SessionRow,
  statusText,
} from "../src/sessions.ts"

const session = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: "349f65b2-1111-4111-8111-111111111111",
  projectId: "aaaaaaaa-2222-4222-8222-222222222222",
  name: "Fix the guard",
  agent: "general",
  harness: "pi",
  status: "working",
  turnState: "open",
  runtime: "hc",
  addressId: "t7@/run/user/501/herdr-core/default.sock",
  repositoryRoot: "/work/shop",
  ...overrides,
})

describe("herdr-app mod session matching", () => {
  it("strips the socket from a herdr-core terminal id", () => {
    assert.equal(coreAddress("t7@/run/user/501/herdr-core/default.sock"), "t7")
    assert.equal(coreAddress("vps/t7@/tmp/core.sock"), "vps/t7")
    assert.equal(coreAddress("w1:p1"), "w1:p1")
    assert.equal(coreAddress(""), "")
  })

  it("focuses the daemon terminal only when this core lists it and no other session owns the label", () => {
    const row = session()
    const terminals = [
      { address: "t7", labels: { "vibest.session": row.id } },
      { address: "t8", labels: { "vibest.session": "other" } },
    ]
    assert.equal(matchTerminal(row, terminals)?.address, "t7")
    assert.deepEqual(focusOf("t7", [{ pane: "p1", terminal: "t7" }]), {
      command: "pane.focus",
      args: { terminal: "t7" },
    })
    assert.deepEqual(focusOf("t7", [{ pane: "p1", terminal: "t8" }]), {
      command: "terminal.keep",
      args: { terminal: "t7" },
    })
    assert.equal(matchTerminal(row, [{ address: "t7", labels: { "vibest.session": "other" } }]), undefined)
    assert.equal(matchTerminal(row, [{ address: "t9", labels: { "vibest.session": row.id } }]), undefined)
    assert.equal(matchTerminal(session({ addressId: "" }), terminals), undefined)
    assert.equal(matchTerminal(session({ addressId: "w1:p4" }), terminals), undefined)
    assert.equal(matchTerminal(row, [{ address: "t7", labels: {} }])?.address, "t7")
  })

  it("reads vibest status and vibest ls without taking a session identity", () => {
    assert.deepEqual(cliArgv("status"), [
      "-u",
      "VIBEST_SESSION_ID",
      "-u",
      "VIBEST_AGENT",
      "-u",
      "VIBEST_PROJECT_ID",
      "vibest",
      "status",
    ])
    assert.equal(parseDaemonRunning(JSON.stringify({ daemon: { status: "running" } })), true)
    assert.equal(parseDaemonRunning(JSON.stringify({ daemon: { status: "not running" } })), false)
    assert.equal(parseDaemonRunning("{"), undefined)
    assert.equal(parseDaemonRunning(JSON.stringify({ client: {} })), undefined)

    const row = session()
    const parsed = parseSessions(
      JSON.stringify([{ ...row, address: { machine: "local", id: row.addressId }, task: "x" }]),
    )
    assert.deepEqual(parsed, [row])
    assert.equal(parseSessions(JSON.stringify([{ id: "only" }])), undefined)
    assert.equal(parseSessions("{"), undefined)
    assert.deepEqual(parseSessions("[]"), [])
  })

  it("groups sessions by project and keeps the daemon status text", () => {
    const first = session()
    const second = session({
      id: "bbbbbbbb-3333-4333-8333-333333333333",
      name: "",
      agent: "review",
      status: "idle",
      turnState: "none",
      repositoryRoot: null,
      projectId: "cccccccc-4444-4444-8444-444444444444",
    })
    const groups = groupSessions([first, session({ id: "dddddddd-5555-4555-8555-555555555555", name: "next" }), second])
    assert.deepEqual(
      groups.map((group) => projectHeading(group.projectId, group.label)),
      ["shop · aaaaaaaa", "cccccccc"],
    )
    assert.equal(groups[0]?.sessions.length, 2)
    assert.equal(statusText(first), "working/open")
    assert.equal(statusText(second), "idle")
  })

  it("drops host rows that are not terminals or panes", () => {
    assert.deepEqual(coreTerminals([{ address: "t1", labels: { "vibest.session": "s" }, cwd: "/x" }, { address: 1 }]), [
      { address: "t1", labels: { "vibest.session": "s" } },
    ])
    assert.deepEqual(modelPanes([{ pane: "p1", terminal: "t1" }, { pane: "p2", terminal: null }, { pane: 3 }]), [
      { pane: "p1", terminal: "t1" },
      { pane: "p2", terminal: null },
    ])
    assert.deepEqual(coreTerminals(null), [])
  })
})
