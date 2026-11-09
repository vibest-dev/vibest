import { assert, describe, it } from "@effect/vitest"

import {
  cliArgv,
  commandNote,
  parseOwnedAddress,
  parseSessions,
  type SessionRow,
  statusVerdict,
} from "../src/agents/cli.ts"
import {
  closePull,
  completePull,
  groupSessions,
  idlePull,
  projectHeading,
  requestPull,
  rowNote,
  rowTitle,
  rowTooltip,
  sessionStatus,
  shortId,
} from "../src/agents/model.ts"

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

describe("agents panel", () => {
  it("parses status the way vibest status prints it", () => {
    assert.deepEqual(cliArgv("status"), [
      "-u",
      "VIBEST_SESSION_ID",
      "-u",
      "VIBEST_AGENT",
      "-u",
      "VIBEST_PROJECT_ID",
      "VIBEST_NO_UPDATE_CHECK=1",
      "vibest",
      "status",
    ])
    assert.deepEqual(cliArgv("ls"), [
      "-u",
      "VIBEST_SESSION_ID",
      "-u",
      "VIBEST_AGENT",
      "-u",
      "VIBEST_PROJECT_ID",
      "vibest",
      "ls",
      "--no-start",
      "--all-projects",
    ])
    assert.equal(cliArgv("ls").includes("VIBEST_NO_UPDATE_CHECK=1"), false)
    assert.equal(
      commandNote(
        {
          code: 1,
          stdout: "",
          stderr:
            "DaemonUnavailable: vibestd is unreachable on /tmp/vibest.sock (not running, or this process may not connect to its socket); ask the user to check it, or to run: vibest daemon",
        },
        "vibest ls failed",
      ),
      "DaemonUnavailable: vibestd is unreachable on /tmp/vibest.sock (not running, or this process may not connect to its socket); ask the user to check it, or to run: vibest daemon",
    )
    assert.equal(commandNote({ code: 1, stdout: "", stderr: "" }, "vibest could not be run"), "vibest could not be run")
    assert.equal(
      commandNote({ code: 2, stdout: "", stderr: "Unknown option: --no-start" }, "vibest ls failed"),
      "Unknown option: --no-start",
    )
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

  it("names why a session is not this window's terminal", () => {
    const row = session()
    assert.equal(rowNote(row), "")
    assert.equal(rowNote(session({ machine: "vps" })), "on another machine")
    assert.equal(rowNote(session({ runtime: "herdr", socket: "", coreAddress: "" })), "runtime herdr")
    assert.equal(rowNote(session({ socket: "", coreAddress: "" })), "no local terminal")
    assert.equal(rowNote(session({ coreAddress: "vps/t7" })), "no local terminal")
  })

  it("puts the title first and the full id and harness in the tooltip", () => {
    const row = session()
    assert.equal(rowTitle(row), "Fix the guard")
    assert.equal(rowTitle(session({ title: "", agent: "" })), "349f65b2")
    assert.equal(shortId(row), "349f65b2")
    assert.equal(rowTooltip(row), "349f65b2-1111-4111-8111-111111111111 · pi")
    assert.equal(
      rowTooltip(session({ machine: "vps" })),
      "349f65b2-1111-4111-8111-111111111111 · pi · on another machine",
    )
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
    assert.equal(sessionStatus(first), "working/open")
    assert.equal(sessionStatus(second), "idle")
  })
})
