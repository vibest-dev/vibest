import { assert, describe, it } from "@effect/vitest"

import {
  commandNote,
  LS_ARGV,
  lsFailure,
  parseOwnedAddress,
  parseSessions,
  readLsResult,
  type SessionRow,
} from "./ls.ts"
import { closePull, completePull, idlePull, requestPull } from "./pull.ts"
import { groupSessions, projectHeading, rowNote, rowTitle, rowTooltip, sessionStatus, shortId } from "./sessions.ts"

const socket = "/run/user/501/herdr-core/default.sock"

const session = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: "349f65b2-1111-4111-8111-111111111111",
  projectId: "aaaaaaaa-2222-4222-8222-222222222222",
  title: "Fix the guard",
  agent: "general",
  harness: "pi",
  status: "working",
  executionState: "open",
  branch: "feat/guard",
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
  executionState: row.executionState,
  git: { branch: row.branch, pushed: false, saved: true, why: "" },
  runtime: row.runtime,
  address: { machine: row.machine, id: row.addressId },
  repositoryRoot: row.repositoryRoot,
})

describe("agents panel", () => {
  it("runs vibest ls as the owner and shows its error text when it fails", () => {
    assert.deepEqual(LS_ARGV, [
      "-u",
      "VIBEST_SESSION_ID",
      "-u",
      "VIBEST_AGENT",
      "-u",
      "VIBEST_PROJECT_ID",
      "vibest",
      "ls",
    ])
    assert.equal(
      commandNote({ code: 1, stdout: "", stderr: "Forbidden: an agent may not run vibest ls\n" }, "vibest ls failed"),
      "Forbidden: an agent may not run vibest ls",
    )
    assert.equal(commandNote({ code: 1, stdout: "", stderr: "" }, "vibest ls failed"), "vibest ls failed")
    assert.equal(commandNote({ code: 0, stdout: '{"sessions":[],"machines":[]}', stderr: "" }, "vibest ls failed"), "")
  })

  it("reads the CLI list object and rejects malformed or legacy payloads", () => {
    const row = session()

    assert.deepEqual(parseSessions(JSON.stringify({ sessions: [listed(row)], machines: [] })), [row])
    assert.deepEqual(
      parseSessions(JSON.stringify({ sessions: [{ ...listed(row), name: "ignored", title: row.title }] })),
      [row],
    )
    assert.deepEqual(parseSessions(JSON.stringify({ sessions: [], machines: [] })), [])
    assert.equal(parseSessions("[]"), undefined)
    assert.equal(parseSessions(JSON.stringify([listed(row)])), undefined)
    assert.equal(parseSessions("{"), undefined)
    assert.equal(parseSessions(JSON.stringify({ sessions: "bad" })), undefined)
    assert.equal(parseSessions(JSON.stringify({ other: [] })), undefined)
    assert.equal(parseSessions(JSON.stringify({ sessions: [{ id: row.id }] })), undefined)
    assert.equal(
      parseSessions(JSON.stringify({ sessions: [{ ...listed(row), address: { id: row.addressId } }] })),
      undefined,
    )
    assert.equal(parseSessions("["), undefined)
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

  it("puts the title first and the full id, harness and branch in the tooltip", () => {
    const row = session()

    assert.equal(rowTitle(row), "Fix the guard")
    assert.equal(rowTitle(session({ title: "", agent: "" })), "349f65b2")
    assert.equal(shortId(row), "349f65b2")
    assert.equal(rowTooltip(row), "349f65b2-1111-4111-8111-111111111111 · pi · feat/guard")
    assert.equal(
      rowTooltip(session({ machine: "vps", branch: "" })),
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
      executionState: "none",
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

describe("readLsResult", () => {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" })
  const at = new Date("2026-11-09T07:08:09Z")

  it("keeps the sessions and stamps the snapshot time", () => {
    const result = readLsResult(ok(JSON.stringify({ sessions: [listed(session())], machines: [] })), at)

    assert.strictEqual(result.sessions.length, 1)
    assert.strictEqual(result.note, "")
    assert.strictEqual(result.asOf, "07:08:09")
  })

  it("says so when nothing is live, when the output is not understood, and when the command fails", () => {
    assert.strictEqual(readLsResult(ok('{"sessions":[],"machines":[]}'), at).note, "No live sessions.")
    assert.strictEqual(readLsResult(ok("[]"), at).note, "vibest ls was not understood")
    assert.strictEqual(readLsResult(ok("{"), at).note, "vibest ls was not understood")
    assert.strictEqual(readLsResult({ code: 2, stdout: "", stderr: "vibestd refused\n" }, at).note, "vibestd refused")
    assert.strictEqual(lsFailure(new Error("no such file")).note, "no such file")
  })
})
