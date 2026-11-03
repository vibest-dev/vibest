// The daily start (architecture.md D4): install, `cd shop`, `vibest`. Outside herdr, `vibest` opens a workspace in this
// run's own herdr session whose shell runs `vibest` again and becomes the project's main agent. S1's Pi runs with this
// run's PI_CODING_AGENT_DIR (passed with --env), never the user's. S10 and S10-pi move a running main agent to another
// terminal with a real herdr and harness (the user's own login and config); S10-pi runs only with VIBEST_E2E_MODEL set.
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import type { Check } from "../check.ts"
import { expect, fail, row, Skip, until, type World } from "../world.ts"

type Entry = { id: string; agent: string; harness: string; routing?: { trace: Array<{ hook: string }> } }

const mains = async (w: World) => (await w.json<Array<Entry>>(["ls"])).filter((e) => e.agent === "main")
const start = (w: World) =>
  w.ok(["--harness", "pi", "--session", w.herdrSession, "--headless", "--env", `PI_CODING_AGENT_DIR=${w.config.pi}`], {
    timeoutMs: 60_000,
  })

/** One request to a herdr session's socket (one JSON line each way); its result, or a thrown error. */
const herdr = (socket: string, method: string, params: Record<string, unknown>) =>
  new Promise<any>((resolve, reject) => {
    const conn = net.createConnection(socket)
    let buffer = ""
    conn.on("connect", () => conn.write(`${JSON.stringify({ id: `e2e-${Date.now()}`, method, params })}\n`))
    conn.on("data", (chunk) => {
      buffer += chunk.toString()
      const end = buffer.indexOf("\n")
      if (end === -1) return
      conn.end()
      const reply = JSON.parse(buffer.slice(0, end)) as { result?: unknown; error?: { message: string } }
      if (reply.error) reject(new Error(`${method}: ${reply.error.message}`))
      else resolve(reply.result)
    })
    conn.on("error", reject)
  })

type Proc = { pid: number; name: string; argv0?: string; argv?: Array<string> | null }
const foreground = async (socket: string, pane: string): Promise<Array<Proc>> =>
  (
    (await herdr(socket, "pane.process_info", { pane_id: pane })) as {
      process_info: { foreground_processes?: Array<Proc> }
    }
  ).process_info.foreground_processes ?? []
const screen = async (socket: string, pane: string): Promise<string> =>
  ((await herdr(socket, "pane.read", { pane_id: pane, source: "visible" })) as { read: { text: string } }).read.text
/** The harness's argv in that pane, if it runs there (Pi renames its process to pi; herdr may then have no argv for it). */
const harnessArgv = async (socket: string, pane: string, harness: "claude" | "pi") => {
  for (const p of await foreground(socket, pane)) {
    // The program itself, not the shell or `vibest` that names it in its arguments.
    const argv = p.argv ?? []
    const names = [p.name, p.argv0 ?? "", ...argv.slice(0, harness === "pi" ? 2 : 1)]
    if (names.some((n) => (harness === "claude" ? /claude/.test(n) : path.basename(n) === "pi"))) return argv
  }
  return undefined
}
/** The value after `flag` in the harness's argv in that pane, if the harness runs there with it. */
const harnessFlag = async (socket: string, pane: string, harness: "claude" | "pi", flag: string) => {
  const argv = (await harnessArgv(socket, pane, harness)) ?? []
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}
const type = async (socket: string, pane: string, text: string) => {
  await herdr(socket, "pane.send_text", { pane_id: pane, text })
  await herdr(socket, "pane.send_keys", { pane_id: pane, keys: ["enter"] })
}
/** Claude's folder trust menu, answered as vibestd answers it for a session: Down to "Yes, I trust this folder", Enter. */
const trust = async (socket: string, pane: string) => {
  const text = await screen(socket, pane)
  if (!/trust this folder/i.test(text)) return false
  const ready = /^\s*❯.*Yes, I trust this folder/im.test(text)
  await herdr(socket, "pane.send_keys", { pane_id: pane, keys: [ready ? "enter" : "down"] })
  return ready
}

/**
 * The model of the real-model checks: VIBEST_E2E_PROVIDER and VIBEST_E2E_MODEL from this run's environment, passed with
 * vibest's own --provider and --model. Unset, each check keeps its own default.
 */
const e2eModel = {
  provider: process.env.VIBEST_E2E_PROVIDER || undefined,
  model: process.env.VIBEST_E2E_MODEL || undefined,
}

/** vibest's options for a main agent on `harness` in the move check, or a Skip saying why it cannot run. */
const moveOptions = (harness: "claude" | "pi"): Array<string> => {
  const { provider, model } = e2eModel
  if (harness === "claude") {
    if (provider && provider !== "anthropic")
      throw new Skip(
        "VIBEST_E2E_PROVIDER names a provider other than anthropic, which vibest does not give a Claude agent (claude.ts checkProvider)",
      )
    return ["--harness", "claude", "--model", model ?? "haiku"]
  }
  // Pi refuses --provider without --model, and Pi's own default model is whatever the user last picked.
  if (!model) throw new Skip("VIBEST_E2E_MODEL is not set (with VIBEST_E2E_PROVIDER for a provider of the user's Pi)")
  return ["--harness", "pi", ...(provider ? ["--provider", provider] : []), "--model", model]
}

/** Has Pi written a conversation with a reply for `cwd` in the user's Pi config? */
const piWrote = async (cwd: string) => {
  const real = await fs.realpath(cwd)
  const dir = path.join(os.homedir(), ".pi", "agent", "sessions", `--${real.slice(1).replaceAll("/", "-")}--`)
  for (const file of await fs.readdir(dir).catch(() => [] as Array<string>)) {
    const text = await Bun.file(path.join(dir, file)).text()
    const head = JSON.parse(text.slice(0, text.indexOf("\n"))) as { cwd?: string }
    if (head.cwd === real && text.includes('"role":"assistant"')) return true
  }
  return false
}

/**
 * The main agent moved between terminals: `harness` runs as the main agent in terminal A; `vibest` in terminal B,
 * answered y, ends A's harness (A keeps its shell) and resumes the same conversation in B. Its own herdr session and
 * vibestd, with the user's harness login and config (read, not changed; the harness keeps its conversation there), as
 * I4 does. An empty ZDOTDIR keeps a pane's zsh from reading the user's zshrc, which can put an installed vibest ahead of
 * this build.
 */
const move = (harness: "claude" | "pi"): Check => ({
  id: harness === "claude" ? "S10" : "S10-pi",
  title: `a ${harness === "claude" ? "Claude" : "Pi"} main agent in terminal A; \`vibest\` in terminal B answered y: A's harness ends and A keeps its shell, B resumes the same conversation`,
  run: async (w) => {
    for (const bin of ["herdr", harness]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
    const options = moveOptions(harness)
    const session = `${w.herdrSession}-move`
    const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
    const zdot = path.join(w.root, "zdotdir-move")
    await fs.mkdir(zdot, { recursive: true })
    const env = { [harness === "claude" ? "CLAUDE_CONFIG_DIR" : "PI_CODING_AGENT_DIR"]: undefined, ZDOTDIR: zdot }
    await w.stopDaemon()
    await w.ok(["daemon"], { env })
    try {
      await w.ok([...options, "--session", session, "--headless"], { env, timeoutMs: 60_000 })
      // Terminal A: the one pane running the harness.
      let a = ""
      await until(
        `${harness} in terminal A`,
        async () => {
          const panes = (
            (await herdr(socket, "pane.list", {}).catch(() => ({ panes: [] }))) as {
              panes: Array<{ pane_id: string }>
            }
          ).panes
          for (const p of panes)
            if (await harnessArgv(socket, p.pane_id, harness)) {
              a = p.pane_id
              return true
            }
          return false
        },
        60_000,
      )
      // One turn, so the harness writes the conversation (vibest resumes only a conversation the harness wrote).
      const status = async (pane: string) =>
        ((await herdr(socket, "pane.get", { pane_id: pane })) as { pane: { agent_status: string } }).pane.agent_status
      await until(
        `${harness} ready in A`,
        async () =>
          harness === "pi"
            ? (await status(a)) === "idle"
            : !(await trust(socket, a)) &&
              !/trust this folder/i.test(await screen(socket, a)) &&
              (await status(a)) === "idle",
        60_000,
      )
      const prompt = "Do not use any tools. Reply with exactly: ok"
      // As vibest prompts a main agent: herdr's agent.prompt submits it (Enter typed into Pi's editor only adds a line).
      await herdr(socket, "agent.prompt", { target: a, text: prompt })
      let conversation: string | undefined
      const projects = path.join(w.home, ".claude", "projects")
      await until(
        "A's conversation written",
        async () => {
          if (harness === "pi") return await piWrote(w.repository)
          // The plugin reports Claude's own conversation id; vibestd keeps it in the main session's row.
          conversation =
            row<{ c: string | null }>(
              w,
              "SELECT s.harness_session_id AS c FROM session s JOIN project p ON p.main_session_id = s.id",
            )?.c ?? undefined
          if (conversation === undefined) return false
          for (const dir of await fs.readdir(projects).catch(() => [] as Array<string>))
            if (await Bun.file(path.join(projects, dir, `${conversation}.jsonl`)).exists()) return true
          return false
        },
        120_000,
      )
      // herdr marks a finished turn nobody looked at "done".
      await until("A idle after its turn", async () => ["idle", "done"].includes(await status(a)), 120_000)
      // Terminal B: a split beside A, at the repository, running `vibest` as a user types it.
      const b = (
        (await herdr(socket, "pane.split", {
          target_pane_id: a,
          direction: "right",
          cwd: w.repository,
          env: { ZDOTDIR: zdot, PATH: w.env().PATH! },
          focus: false,
        })) as { pane: { pane_id: string } }
      ).pane.pane_id
      await until("B's shell", async () => /\S/.test(await screen(socket, b)), 30_000)
      await type(socket, b, ["vibest", ...options].join(" "))
      await until(
        "B asks to move the main agent",
        async () => (await screen(socket, b)).includes("Move it here and continue? [y/N]"),
        60_000,
      )
      await type(socket, b, "y")
      if (harness === "claude") {
        await until(
          "Claude resumed in B",
          async () => (await harnessFlag(socket, b, "claude", "--resume")) !== undefined,
          60_000,
        )
        const resumed = await harnessFlag(socket, b, "claude", "--resume")
        expect(resumed === conversation, `B resumed ${resumed}, not ${conversation}`)
      } else {
        // herdr shows no argv for Pi, so the proof is Pi's own: B shows A's conversation.
        await until("Pi in B shows A's conversation", async () => (await screen(socket, b)).includes(prompt), 60_000)
      }
      // A: its harness gone, the pane still there at its shell.
      await until("A's harness gone", async () => (await harnessArgv(socket, a, harness)) === undefined, 20_000)
      const kept = ((await herdr(socket, "pane.list", {})) as { panes: Array<{ pane_id: string }> }).panes
      expect(
        kept.some((p) => p.pane_id === a),
        `pane ${a} closed`,
      )
      // Only its shell, once what the harness's own extensions started (Pi's update checks) has finished too.
      const shellOnly = async () => {
        const procs = await foreground(socket, a)
        return procs.length > 0 && procs.every((p) => /^-?(zsh|bash|sh|fish)$/.test(path.basename(p.name)))
      }
      await until("only a shell in A", shellOnly, 30_000).catch(async () =>
        fail(`A runs ${JSON.stringify(await foreground(socket, a))}`),
      )
      // vibest's record: the same main agent, now at B.
      const mains = (await w.json<Array<{ agent: string; address: { id: string } }>>(["ls"])).filter(
        (e) => e.agent === "main",
      )
      expect(mains.length === 1 && mains[0]!.address.id.endsWith(b), `main agents: ${JSON.stringify(mains)}`)
    } finally {
      await w.stopDaemon()
      if (
        await fs.stat(path.dirname(socket)).then(
          () => true,
          () => false,
        )
      ) {
        await w.run(w.root, ["herdr", "session", "stop", session])
        await w.run(w.root, ["herdr", "session", "delete", session])
      }
    }
  },
})

const checks: ReadonlyArray<Check> = [
  {
    id: "S1",
    title:
      "in a project directory, `vibest` starts its main agent in this run's herdr session; `vibest ls` shows it first",
    run: async (w) => {
      if (!Bun.which("pi")) throw new Skip("pi not on PATH")
      if (!Bun.which("herdr")) throw new Skip("herdr not on PATH")
      const out = await start(w)
      expect(out.includes("the main agent is starting in"), `vibest said: ${out}`)
      await until("the main agent in vibest ls", async () => (await mains(w)).length === 1, 30_000)
      const [main] = await mains(w)
      expect(main!.harness === "pi", `main agent: ${JSON.stringify(main)}`)
      expect(
        main!.routing === undefined || main!.routing.trace.every((t) => typeof t.hook === "string"),
        `routing: ${JSON.stringify(main)}`,
      )
    },
  },
  move("claude"),
  move("pi"),
]

export default checks
