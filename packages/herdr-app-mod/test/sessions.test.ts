import { assert, describe, it } from "@effect/vitest"

import {
  cliArgv,
  closePull,
  completePull,
  coreTerminals,
  groupSessions,
  idlePull,
  modelPanes,
  parseOwnedAddress,
  parseSessions,
  placeSession,
  projectHeading,
  requestPull,
  type SessionRow,
  statusText,
  statusVerdict,
} from "../src/sessions.ts"

const socket = "/run/user/501/herdr-core/default.sock"

const session = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: "349f65b2-1111-4111-8111-111111111111",
  projectId: "aaaaaaaa-2222-4222-8222-222222222222",
  title: "Fix the guard",
  agent: "general",
  harness: "pi",
  status: "working",
  turnState: "open",
  runtime: "hc",
  machine: "local",
  addressId: `t7@${socket}`,
  socket,
  coreAddress: "t7",
  repositoryRoot: "/work/shop",
  ...overrides,
})

const listed = (row: SessionRow) => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  agent: row.agent,
  harness: row.harness,
  status: row.status,
  turnState: row.turnState,
  runtime: row.runtime,
  address: { machine: row.machine, id: row.addressId },
  repositoryRoot: row.repositoryRoot,
})

const runningStatus = {
  client: { version: "0.0.1-beta.17", command: ["vibest"] },
  daemon: {
    status: "running",
    version: "0.0.1-beta.17",
    sameVersion: true,
    protocol: 5,
    socket: "/Users/dinq/.vibest/vibest.sock",
  },
  runtimes: [{ kind: "hc", status: "online" }],
}

describe("herdr-app mod", () => {
  it("parses status the way vibest status prints it", () => {
    assert.deepEqual(cliArgv("ls"), [
      "-u",
      "VIBEST_SESSION_ID",
      "-u",
      "VIBEST_AGENT",
      "-u",
      "VIBEST_PROJECT_ID",
      "vibest",
      "ls",
    ])
    assert.deepEqual(statusVerdict(JSON.stringify(runningStatus)), { list: true })
    assert.deepEqual(
      statusVerdict(
        JSON.stringify({
          client: { version: "0.0.1-beta.17" },
          daemon: { status: "not running", socket: "/tmp/vibest.sock" },
          runtimes: null,
        }),
      ),
      { list: false, message: "vibestd is not running" },
    )
    assert.deepEqual(
      statusVerdict(
        JSON.stringify({
          client: { version: "0.0.1-beta.17" },
          daemon: { status: "running", version: "0.0.1-beta.9", sameVersion: false, protocol: 4 },
        }),
      ),
      { list: false, message: "vibestd 0.0.1-beta.9 is not this vibest 0.0.1-beta.17" },
    )
    assert.equal(statusVerdict("{"), undefined)
    assert.deepEqual(statusVerdict(JSON.stringify({ daemon: { status: "running", sameVersion: true } })), {
      list: false,
      message: "vibest status has no protocol",
    })
    assert.equal(statusVerdict("null"), undefined)
  })

  it("reads the CLI list and rejects a malformed one", () => {
    const row = session()
    assert.deepEqual(parseSessions(JSON.stringify([listed(row)])), [row])
    assert.deepEqual(parseSessions(JSON.stringify([{ ...listed(row), name: "ignored", title: row.title }])), [row])
    assert.equal(parseSessions("{"), undefined)
    assert.equal(parseSessions(JSON.stringify({ sessions: [] })), undefined)
    assert.equal(parseSessions(JSON.stringify([{ id: row.id }])), undefined)
    assert.equal(parseSessions(JSON.stringify([{ ...listed(row), address: { id: row.addressId } }])), undefined)
    assert.equal(parseSessions("["), undefined)
    assert.deepEqual(parseSessions("[]"), [])
    assert.equal(parseOwnedAddress("w1:p1"), undefined)
    assert.deepEqual(parseOwnedAddress(`t7@${socket}`), { address: "t7", socket })
  })

  it("focuses only a local herdr-core pane with the same address and session label", () => {
    const row = session()
    const terminals = [
      { address: "t7", labels: { "vibest.session": row.id } },
      { address: "t8", labels: { "vibest.session": row.id } },
    ]
    const panes = [{ pane: "p1", terminal: "t7" }]
    assert.deepEqual(placeSession(row, terminals, panes), { action: "focus", terminal: "t7" })
    assert.deepEqual(placeSession(row, [{ address: "t8", labels: { "vibest.session": row.id } }], panes), {
      action: "none",
      reason: "not in this window",
    })
    assert.deepEqual(placeSession(row, [{ address: "t7", labels: {} }], panes), {
      action: "none",
      reason: "not in this window",
    })
    assert.deepEqual(placeSession(row, [{ address: "t7", labels: { "vibest.session": "other" } }], panes), {
      action: "none",
      reason: "not in this window",
    })
    assert.deepEqual(placeSession(session({ machine: "vps", coreAddress: "t7", socket }), terminals, panes), {
      action: "none",
      reason: "on another machine",
    })
    assert.deepEqual(
      placeSession(
        row,
        [
          { address: "t7", labels: { "vibest.session": row.id } },
          { address: "t7", labels: { "vibest.session": row.id } },
        ],
        panes,
      ),
      { action: "none", reason: "ambiguous" },
    )
    assert.deepEqual(placeSession(row, terminals, [{ pane: "p9", terminal: "t8" }]), {
      action: "none",
      reason: "no pane to focus",
    })
    assert.deepEqual(placeSession(session({ runtime: "herdr", coreAddress: "", socket: "" }), terminals, panes), {
      action: "none",
      reason: "runtime herdr",
    })
    assert.deepEqual(placeSession(session({ coreAddress: "vps/t7" }), terminals, panes), {
      action: "none",
      reason: "no local terminal",
    })
  })

  it("drops a snapshot when a newer read or unload wins", () => {
    let pull = requestPull(idlePull())
    const first = pull.token
    pull = requestPull(pull)
    assert.equal(pull.again, true)
    const stale = completePull(pull, first)
    assert.equal(stale.apply, false)
    assert.equal(stale.pull.running, true)
    assert.notEqual(stale.pull.token, first)
    const late = completePull(stale.pull, first)
    assert.equal(late.apply, false)
    assert.equal(late.pull.running, true)
    const closed = completePull(closePull(stale.pull), stale.pull.token)
    assert.equal(closed.apply, false)
    assert.equal(requestPull(closed.pull), closed.pull)
    const fresh = completePull(requestPull(idlePull()), 1)
    assert.equal(fresh.apply, true)
    assert.equal(fresh.pull.running, false)
  })

  it("groups sessions and keeps the daemon status text", () => {
    const first = session()
    const second = session({
      id: "bbbbbbbb-3333-4333-8333-333333333333",
      title: "",
      agent: "review",
      status: "idle",
      turnState: "none",
      repositoryRoot: null,
      projectId: "cccccccc-4444-4444-8444-444444444444",
    })
    const groups = groupSessions([
      first,
      session({ id: "dddddddd-5555-4555-8555-555555555555", title: "next" }),
      second,
    ])
    assert.deepEqual(
      groups.map((group) => projectHeading(group.projectId, group.label)),
      ["shop · aaaaaaaa", "cccccccc"],
    )
    assert.equal(groups[0]?.sessions.length, 2)
    assert.equal(statusText(first), "working/open")
    assert.equal(statusText(second), "idle")
    assert.deepEqual(coreTerminals(null), [])
    assert.deepEqual(modelPanes([{ pane: "p1", terminal: null }, { pane: 2 }]), [{ pane: "p1", terminal: null }])
  })
})
