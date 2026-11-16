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

const hcKey = (c: string) =>
  c === " " ? "space" : c === ":" ? "shift+;" : /[A-Z]/.test(c) ? `shift+${c.toLowerCase()}` : c

export const cursorWorld = async (w: World, runtime: Runtime, name: string, entry: "pi" | "cursor" = "pi") => {
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
  const placement = core
    ? { runtime: "hc", extra: ["--runtime", "hc"], hc: { run: core.hc }, name: `${name}-entry` }
    : { session }
  if (entry === "pi") await w.entry({ cwd: repo, processEnv: daemonEnv, ...placement })
  else {
    await w.ok(["daemon"], { cwd: repo, env: daemonEnv })
    await w.startEntry({ harness: "cursor", cwd: repo, processEnv: daemonEnv, timeoutMs: 120_000, ...placement })
  }
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
    if (core) return (await core.hc("read", terminalOf(id))).stdout
    const read = await herdr(herdrSocket, "pane.read", {
      pane_id: terminalOf(id),
      source: "visible",
      strip_ansi: true,
    }).catch((e: Error) => ({ read: { text: `(no screen: ${e.message})` } }))
    return String((read.read as { text?: string } | undefined)?.text ?? "")
  }
  const typeText = async (id: string, text: string) => {
    if (core) {
      const r = await core.hc("keys", terminalOf(id), ...[...text].map(hcKey))
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
const LONG_COMMAND = "Run this shell command exactly: sleep 120."
const LONG_REPLY = "Then reply with exactly: slept"

const reports = (runtime: Runtime): Check => ({
  id: `I10-${runtime}`,
  tier: "agent",
  title: `Cursor (real model) on ${runtime === "hc" ? "herdr-core" : "herdr"}: its first task is typed only after it is ready, vibest ls shows it working during an execution and idle after it, an execution that speaks, runs a tool and answers is exactly one completed execution carrying the reply, a message sent while unsent text sits in its input box stays queued until the box is empty, vibest interrupt ends the next one interrupted with no notice, and the plugin never writes to the terminal; its hook events and screens are recorded`,
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
          return c.executions(id)[0]?.outcome != null
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
      const firstEvents = (await hookEvents(w)).length
      await w.ok(["send", id, "--", LONG_COMMAND], { cwd: c.repo })
      await Bun.sleep(12_000)
      const held = await c.screen(id)
      keep("a message sent while text is in the box", held)
      expect(
        c.executions(id).length === 1 && held.includes("draft text left in the box") && !held.includes("sleep 120"),
        `a message was typed over unsent text: executions ${JSON.stringify(c.executions(id))}`,
      )
      expect(
        (await c.log()).includes("delivery waits: the input box is not empty"),
        "delivery did not wait for the box",
      )
      await c.pressKeys(id, ["ctrl+u"])
      await Bun.sleep(1_500)
      keep("after ctrl+u", await c.screen(id))
      await w.ok(["send", id, "--", LONG_REPLY], { cwd: c.repo })
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

const SEND_THEN_HERDR =
  "Use vibest send to send the message i12-hello to the session that started you. Then run this shell command exactly: herdr pane list > herdr-ran.txt. Then reply with exactly: pong"

const noApprovalDialog: Check = {
  id: "I12",
  tier: "agent",
  title:
    "Cursor (real model) on its default allowlist approval mode with no allow rule: a vibest session runs vibest send to the session that started it and the message arrives, the session is never blocked on Cursor's approval dialog, and asked to run herdr, herdr does not run",
  run: async (w) => {
    const c = await cursorWorld(w, "herdr", "i12")
    await fs.writeFile(
      path.join(w.config.cursor, "cli-config.json"),
      JSON.stringify({ version: 1, approvalMode: "allowlist", permissions: { allow: [], deny: [] } }),
    )
    const ids: Array<string> = []
    try {
      const id = await c.start(SEND_THEN_HERDR)
      ids.push(id)
      const seen = new Set<string>()
      await until(
        "the execution to end",
        async () => {
          const e = await c.listed(id)
          if (e) seen.add(e.status)
          return c.executions(id).some((x) => x.outcome !== null)
        },
        240_000,
      ).catch(async (e: Error) => {
        throw new Error(`${e.message}; seen ${[...seen].join(", ")}; screen:\n${await c.screen(id)}`)
      })
      const [execution] = c.executions(id)
      expect(
        execution?.outcome === "completed" && /\bpong\b/.test(execution.reply ?? ""),
        `the execution: ${JSON.stringify(execution)}`,
      )
      expect(!seen.has("blocked"), `the session was blocked: ${[...seen].join(", ")}`)
      const sent = row<{ n: number }>(
        w,
        "SELECT count(*) AS n FROM inbox WHERE sender_session_id = ? AND kind = 'send' AND instr(content, 'i12-hello') > 0",
        id,
      )?.n
      expect((sent ?? 0) >= 1, `messages with i12-hello from ${id}: ${sent}`)
      const worktree = await fs.realpath(
        row<{ d: string }>(w, `SELECT directory AS d FROM ${SESSIONS} s WHERE id = ?`, id)?.d ?? "",
      )
      expect(!(await Bun.file(path.join(worktree, "herdr-ran.txt")).exists()), "herdr ran: herdr-ran.txt exists")
    } finally {
      await c.close(ids)
    }
  },
}

const conversationAtStart: Check = {
  id: "I13",
  tier: "agent",
  title:
    "Cursor (real model) on herdr: the session's conversation is recorded at its session start; its pane closed before any reply, a vibest send reopens it on that conversation and the reply arrives; closed again after a reply, the next send resumes it too",
  run: async (w) => {
    const c = await cursorWorld(w, "herdr", "i13")
    const ids: Array<string> = []
    const fact = (id: string, type: string) =>
      rows<{ at: number; data: string }>(
        w,
        "SELECT at, data FROM event WHERE aggregate = ? AND type = ? ORDER BY seq",
        id,
        type,
      )
    const closePane = async (id: string) => {
      const ended = fact(id, "process.ended").length
      await herdr(c.herdrSocket, "pane.close", { pane_id: c.terminalOf(id) })
      await until("the closed pane seen exited", () => fact(id, "process.ended").length > ended, 30_000)
    }
    const replied = (id: string, marker: string) =>
      until(
        `the reply ${marker}`,
        () => c.executions(id).some((x) => x.outcome === "completed" && (x.reply ?? "").includes(marker)),
        240_000,
      ).catch(async (e: Error) => {
        throw new Error(`${e.message}; executions ${JSON.stringify(c.executions(id))}\n${(await c.log()).slice(-3000)}`)
      })
    try {
      const id = await c.start("Run this shell command exactly: sleep 90. Then reply with exactly: i13-first")
      ids.push(id)
      await until("the session start reported", () => fact(id, "process.ready").length > 0, 120_000)
      const ready = fact(id, "process.ready")[0]!
      await until("the conversation", () => fact(id, "process.conversation").length > 0, 2_000).catch(() => undefined)
      const noted = fact(id, "process.conversation")
      expect(
        noted.length > 0 && Math.abs(noted[0]!.at - ready.at) <= 1_000,
        `the conversation was not recorded at the session start: ready ${JSON.stringify(ready)}, conversation ${JSON.stringify(noted)}`,
      )
      const conversation = (JSON.parse(noted[0]!.data) as { conversation: string }).conversation
      await until("the first task taken", () => fact(id, "execution.accepted").length > 0, 60_000)
      await closePane(id)
      expect(
        !c.executions(id).some((x) => x.outcome === "completed"),
        `a reply came before the pane closed: ${JSON.stringify(c.executions(id))}`,
      )
      await w.ok(["send", id, "--", "Reply with exactly: i13-second"], { cwd: c.repo })
      await replied(id, "i13-second")
      const resumed = fact(id, "process.conversation").map(
        (f) => (JSON.parse(f.data) as { conversation: string }).conversation,
      )
      expect(
        resumed.every((r) => r === conversation),
        `the reopened Cursor is in another conversation: ${conversation} then ${resumed.join(", ")}`,
      )
      await closePane(id)
      await w.ok(["send", id, "--", "Reply with exactly: i13-third"], { cwd: c.repo })
      await replied(id, "i13-third")
      const third = fact(id, "process.conversation").map(
        (f) => (JSON.parse(f.data) as { conversation: string }).conversation,
      )
      expect(
        third.every((r) => r === conversation),
        `conversations: ${third.join(", ")}`,
      )
      expect(fact(id, "process.started").length === 3, `processes: ${fact(id, "process.started").length}`)
    } finally {
      await c.close(ids)
    }
  },
}

const entryTakesMessages = (runtime: Runtime): Check => ({
  id: `I14-${runtime}`,
  tier: "agent",
  title: `Cursor (real model) as the entry session on ${runtime === "hc" ? "herdr-core" : "herdr"}: a message sent while it is idle with an empty box is typed and answered as its execution; one sent while the user's unsent text sits in the box waits, the box unchanged, and is typed alone after that text is submitted and answered; one sent while it works on a prompt typed in its pane is typed only after that work ends, each reply on its own execution`,
  run: async (w, evidence) => {
    const c = await cursorWorld(w, runtime, "i14", "cursor")
    const screens: Array<string> = []
    const keep = (label: string, text: string) => screens.push(`=== ${label}\n${text.trimEnd()}`)
    const entry = (await w.entryOf(c.repo))!
    const answered = (marker: string) =>
      until(
        `the reply ${marker}`,
        () => c.executions(entry).some((x) => x.outcome === "completed" && (x.reply ?? "").includes(marker)),
        240_000,
      ).catch(async (e: Error) => {
        throw new Error(`${e.message}; executions ${JSON.stringify(c.executions(entry))}\n${await c.screen(entry)}`)
      })
    const onScreen = (marker: string, ms: number) =>
      until(`${marker} on the screen`, async () => (await c.screen(entry)).includes(marker), ms)
    try {
      await until(
        "the Cursor entry session ready and idle",
        async () =>
          row<{ r: number | null }>(w, `SELECT ready_at AS r FROM process WHERE session_id = ? ORDER BY id DESC`, entry)
            ?.r != null && (await c.listed(entry))?.status === "idle",
        180_000,
      ).catch(async (e: Error) => {
        throw new Error(`${e.message}; screen:\n${await c.screen(entry).catch(() => "")}`)
      })
      await w.ok(["send", entry, "--", "Reply with exactly: i14-one"], { cwd: c.repo })
      await answered("i14-one")
      keep("after the first message", await c.screen(entry))

      await c.typeText(entry, "Reply with exactly: i14-typed")
      await Bun.sleep(1_500)
      const before = c.executions(entry).length
      await w.ok(["send", entry, "--", "Reply with exactly: i14-two"], { cwd: c.repo })
      await Bun.sleep(12_000)
      const held = await c.screen(entry)
      keep("a message sent while text is in the box", held)
      expect(
        c.executions(entry).length === before && held.includes("i14-typed") && !held.includes("i14-two"),
        `a message was typed over the user's text: executions ${JSON.stringify(c.executions(entry))}`,
      )
      await c.pressKeys(entry, ["enter"])
      await answered("i14-two")
      const two = c.executions(entry).at(-1)!
      const handed = rows<{ content: string }>(
        w,
        "SELECT content FROM inbox WHERE session_id = ? AND execution_id = ?",
        entry,
        two.id,
      ).map((r) => r.content)
      expect(
        handed.length === 1 && handed[0]!.includes("i14-two") && !(two.reply ?? "").includes("i14-typed"),
        `the queued message was not typed alone: ${JSON.stringify({ two, handed })}`,
      )
      keep("after the submitted text and the queued message", await c.screen(entry))

      await c.typeText(entry, "Run this shell command exactly: sleep 25. Then reply with exactly: i14-slept")
      await Bun.sleep(1_000)
      await c.pressKeys(entry, ["enter"])
      await onScreen("Working", 60_000)
      const working = c.executions(entry).length
      await w.ok(["send", entry, "--", "Reply with exactly: i14-three"], { cwd: c.repo })
      await Bun.sleep(5_000)
      expect(
        c.executions(entry).length === working,
        `a message was typed while the typed prompt ran: ${JSON.stringify(c.executions(entry))}`,
      )
      await answered("i14-three")
      const after = await c.screen(entry)
      keep("after the typed prompt and the message sent meanwhile", after)
      const three = c.executions(entry).at(-1)!
      expect(
        !(three.reply ?? "").includes("i14-slept") && after.indexOf("i14-slept") < after.lastIndexOf("i14-three"),
        `the replies crossed: ${JSON.stringify(three)}`,
      )
    } finally {
      await w.writeEvidence(path.join(evidence, `I14-${runtime}-screens.txt`), `${screens.join("\n")}\n`)
      await c.close([])
    }
  },
})

const checks: ReadonlyArray<Check> = [
  reports("herdr"),
  reports("hc"),
  noApprovalDialog,
  conversationAtStart,
  entryTakesMessages("herdr"),
  entryTakesMessages("hc"),
]

export default checks
