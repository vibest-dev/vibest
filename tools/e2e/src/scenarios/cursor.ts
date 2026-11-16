import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { expect, harnesses, herdr, row, rows, SESSIONS, Skip, until, type World } from "../world.ts"
import { addCursorPlugin } from "../world/plugins.ts"
import { isolatedCore } from "./hc.ts"
import { dropHerdrSession, project } from "./inbox.ts"

type Runtime = "herdr" | "hc"
type Listed = { id: string; status: string; executionState: string }
type Execution = { id: number; outcome: string | null; reply: string | null; typed: string | null }

const HOOK_LOG = "cursor-hooks.log"

const requireCursor = async (w: World, runtime: Runtime) => {
  for (const bin of ["cursor-agent", runtime])
    if (!Bun.which(bin, { PATH: w.env().PATH! })) throw new Skip(`${bin} not on PATH`)
  const login = await w.run(w.repository, ["cursor-agent", "status"])
  if (!/Logged in/.test(login.stdout + login.stderr))
    throw new Skip(`cursor-agent is not logged in: ${(login.stdout + login.stderr).trim()}`)
}

const loggingHarnesses = async (w: World) => {
  const dir = path.join(w.root, "harnesses-logged")
  await fs.cp(harnesses, dir, { recursive: true })
  const hooks = path.join(dir, "cursor", "hooks")
  await fs.rename(path.join(hooks, "vibest.sh"), path.join(hooks, "vibest-real.sh"))
  const log = path.join(w.root, HOOK_LOG)
  await fs.writeFile(
    path.join(hooks, "vibest.sh"),
    [
      "#!/bin/sh",
      "input=$(cat)",
      `printf '%s %s\\n' "$1" "$(printf '%s' "$input" | tr '\\n' ' ')" >> '${log}'`,
      `printf '%s' "$input" | sh "$(dirname "$0")/vibest-real.sh" "$@"`,
      "",
    ].join("\n"),
  )
  return dir
}

export const hookEvents = async (w: World) =>
  (await fs.readFile(path.join(w.root, HOOK_LOG), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ")
      const action = line.slice(0, space)
      try {
        const event = JSON.parse(line.slice(space + 1)) as { hook_event_name?: string; conversation_id?: string }
        return { action, event: event.hook_event_name ?? "?", conversation: event.conversation_id }
      } catch {
        return { action, event: "?", conversation: undefined }
      }
    })

export const cursorWorld = async (w: World, runtime: Runtime, name: string) => {
  await requireCursor(w, runtime)
  const logged = await loggingHarnesses(w)
  await addCursorPlugin(w, logged)
  const repo = await project(w, name)
  const daemonEnv = { CLAUDE_CONFIG_DIR: undefined, VIBEST_HARNESSES: logged }
  const session = `${w.herdrSession}-${name}`
  const herdrSocket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  await w.stopDaemon()
  const core = runtime === "hc" ? await isolatedCore(w, w.config.pi, name) : undefined
  if (core) w.ownRuntimes.add("hc")
  await w.entry({
    cwd: repo,
    processEnv: daemonEnv,
    ...(core
      ? { runtime: "hc", extra: ["--runtime", "hc"], hc: { run: core.hc }, name: `${name}-entry` }
      : { session }),
  })
  const runtimeOf = (id: string) =>
    (
      JSON.parse(row<{ r: string }>(w, `SELECT runtime AS r FROM ${SESSIONS} s WHERE id = ?`, id)?.r ?? "{}") as {
        id?: string
      }
    ).id ?? ""
  const terminalOf = (id: string) => {
    const at = runtimeOf(id)
    return core ? at.slice(0, at.indexOf("@")) : (at.split("/")[1] ?? "")
  }
  const screen = async (id: string) => {
    const peek = await w.vibest(["peek", id, "--lines", "60"], { cwd: repo })
    return peek.stdout
  }
  const typeText = async (id: string, text: string) => {
    if (core) {
      const r = await core.hc("keys", terminalOf(id), ...[...text].map((c) => (c === " " ? "space" : c)))
      expect(r.code === 0, `hc keys: ${r.stderr}${r.stdout}`)
    } else await herdr(herdrSocket, "pane.send_text", { pane_id: terminalOf(id), text })
  }
  const pressKeys = async (id: string, keys: ReadonlyArray<string>) => {
    if (core) {
      const r = await core.hc("keys", terminalOf(id), ...keys)
      expect(r.code === 0, `hc keys: ${r.stderr}${r.stdout}`)
    } else await herdr(herdrSocket, "pane.send_keys", { pane_id: terminalOf(id), keys })
  }
  const freshScreen = async () => {
    const command = `cd '${repo}' && cursor-agent --trust`
    if (core) {
      const name = "fresh-cursor"
      expect((await core.hc("run", "--bg", "--keep", "--name", name)).code === 0, "hc run for the fresh Cursor")
      await core.hc("send", name, command)
      await Bun.sleep(20_000)
      const read = (await core.hc("read", name)).stdout
      await core.hc("keys", name, "ctrl+c")
      await core.hc("keys", name, "ctrl+c")
      await core.hc("kill", name)
      return read
    }
    const created = await herdr(herdrSocket, "tab.create", { cwd: repo, env: w.env(), focus: false })
    const pane = (created.root_pane as { pane_id: string }).pane_id
    await Bun.sleep(2_000)
    await herdr(herdrSocket, "pane.send_text", { pane_id: pane, text: command })
    await herdr(herdrSocket, "pane.send_keys", { pane_id: pane, keys: ["enter"] })
    await Bun.sleep(20_000)
    const r = await herdr(herdrSocket, "pane.read", { pane_id: pane, source: "visible", strip_ansi: true })
    await herdr(herdrSocket, "pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] })
    await herdr(herdrSocket, "pane.send_keys", { pane_id: pane, keys: ["ctrl+c"] })
    await herdr(herdrSocket, "pane.close", { pane_id: pane }).catch(() => undefined)
    return String((r.read as { text?: string } | undefined)?.text ?? "")
  }
  const start = async (task: string, ...flags: Array<string>) =>
    (
      JSON.parse(
        await w.okViaEntry(
          ["run", "cursor", "--runtime", runtime, ...(core ? [] : ["--session", session]), ...flags, "--", task],
          { cwd: repo, timeoutMs: 120_000 },
        ),
      ) as { id: string }
    ).id
  const listed = async (id: string) =>
    (await w.json<{ sessions: Array<Listed> }>(["ls"], { cwd: repo })).sessions.find((e) => e.id === id)
  const executions = (id: string) =>
    rows<Execution>(w, "SELECT id, outcome, reply, typed FROM execution WHERE session_id = ? ORDER BY id", id)
  const notices = (id: string) =>
    row<{ n: number }>(w, "SELECT count(*) AS n FROM inbox WHERE sender_session_id = ? AND kind = 'notice'", id)?.n ?? 0
  const log = () => fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")
  const close = async (ids: ReadonlyArray<string>) => {
    for (const id of ids) await w.vibest(["archive", id], { cwd: repo, timeoutMs: 60_000 })
    await w.stopDaemon()
    if (core) await core.stop()
    else await dropHerdrSession(w, session)
  }
  return {
    repo,
    core,
    session,
    herdrSocket,
    terminalOf,
    screen,
    typeText,
    pressKeys,
    freshScreen,
    start,
    listed,
    executions,
    notices,
    log,
    close,
  }
}

const TOOL_TASK =
  "First write one short sentence saying you are starting. Then run this shell command exactly: echo i10-tool. Then reply with exactly: pong"
const LONG_TASK = "Run this shell command exactly: sleep 120. Then reply with exactly: slept"

const reports = (runtime: Runtime): Check => ({
  id: `I10-${runtime}`,
  tier: "agent",
  title: `Cursor (real model) on ${runtime === "hc" ? "herdr-core" : "herdr"}: its first task is typed only after it is ready, vibest ls shows it working during an execution and idle after it, an execution that speaks, runs a tool and answers is exactly one completed execution carrying the reply, vibest interrupt ends the next one interrupted with no notice, and the plugin never writes to the terminal; its hook events and screens are recorded`,
  run: async (w, evidence) => {
    const c = await cursorWorld(w, runtime, `i10${runtime}`)
    const ids: Array<string> = []
    const screens: Array<string> = []
    const keep = (label: string, text: string) => screens.push(`=== ${label}\n${text}`)
    try {
      const id = await c.start(TOOL_TASK)
      ids.push(id)
      const seen = new Set<string>()
      let workingScreen = ""
      await until(
        "the first execution to end",
        async () => {
          const e = await c.listed(id)
          if (e) seen.add(`${e.status}/${e.executionState}`)
          if (e?.executionState === "open" && workingScreen === "") workingScreen = await c.screen(id)
          return e !== undefined && e.executionState !== "open" && c.executions(id).length > 0
        },
        240_000,
      ).catch(async (e: Error) => {
        throw new Error(`${e.message}; seen ${[...seen].join(", ")}; screen:\n${await c.screen(id)}`)
      })
      keep("working", workingScreen)
      await Bun.sleep(8_000)
      const first = c.executions(id)
      expect(
        first.length === 1 && first[0]!.outcome === "completed" && /\bpong\b/.test(first[0]!.reply ?? ""),
        `executions after the first task: ${JSON.stringify(first)}`,
      )
      const after = await c.listed(id)
      expect(after?.status === "idle", `vibest ls after the execution: ${JSON.stringify(after)}`)
      expect(
        [...seen].some((s) => s.startsWith("working/")),
        `vibest ls never showed working during the execution: ${[...seen].join(", ")}`,
      )
      keep("empty after an execution", await c.screen(id))

      await c.typeText(id, "draft text left in the box")
      await Bun.sleep(1_500)
      keep("text in the box", await c.screen(id))
      await c.pressKeys(id, ["ctrl+u"])
      await Bun.sleep(1_500)
      keep("after ctrl+u", await c.screen(id))

      const firstEvents = (await hookEvents(w)).length
      await w.ok(["send", id, "--", LONG_TASK], { cwd: c.repo })
      await until(
        "the second execution at work",
        async () =>
          c.executions(id).length === 2 &&
          (await hookEvents(w)).slice(firstEvents).some((e) => e.event === "preToolUse") &&
          (await c.listed(id))?.executionState === "open",
        180_000,
      )
      await Bun.sleep(3_000)
      await w.ok(["interrupt", id], { cwd: c.repo, timeoutMs: 60_000 })
      await until("the interrupted execution", () => c.executions(id)[1]?.outcome != null, 60_000)
      await Bun.sleep(3_000)
      keep("after vibest interrupt", await c.screen(id))
      const second = c.executions(id)
      expect(
        second.length === 2 && second[1]!.outcome === "interrupted",
        `executions after the interrupt: ${JSON.stringify(second)}`,
      )
      expect(c.notices(id) === 0, `notices from ${id}: ${c.notices(id)}`)
      const log = await c.log()
      expect(!log.includes("did not reach vibestd"), "a report did not reach vibestd")
      expect(
        !screens.some((s) => /vibest integration|did not reach vibestd/.test(s)),
        "the plugin wrote to the terminal",
      )
      keep("fresh, before any input", await c.freshScreen())
      const timing = row<{ ready: number | null; started: number }>(
        w,
        `SELECT p.ready_at AS ready, (SELECT min(started_at) FROM execution x WHERE x.session_id = p.session_id) AS started
          FROM process p WHERE p.session_id = ? ORDER BY p.id LIMIT 1`,
        id,
      )
      expect(
        timing?.ready != null && timing.ready <= timing.started,
        `the first task was typed before the session was ready: ${JSON.stringify(timing)}`,
      )
    } finally {
      await w.writeEvidence(path.join(evidence, `I10-${runtime}-screens.txt`), `${screens.join("\n")}\n`)
      await w.writeEvidence(
        path.join(evidence, `I10-${runtime}-hooks.json`),
        `${JSON.stringify(
          (await hookEvents(w)).map((e) => `${e.action} ${e.event}`),
          null,
          1,
        )}\n`,
      )
      await c.close(ids)
    }
  },
})

const checks: ReadonlyArray<Check> = [reports("herdr"), reports("hc")]

export default checks
