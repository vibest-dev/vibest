// The daily start (architecture.md D4): install, `cd shop`, `vibest`. Outside herdr, `vibest` opens a workspace in this
// run's own herdr session whose shell runs `vibest` again and becomes the project's main agent. Pi runs with this run's
// PI_CODING_AGENT_DIR (passed with --env), never the user's. S10 moves a running Claude main agent to another terminal
// with a real herdr and Claude (the user's own login).
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"

import type { Check } from "../check.ts"
import { expect, Skip, until, type World } from "../world.ts"

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

type Proc = { pid: number; name: string; argv?: Array<string> | null }
const foreground = async (socket: string, pane: string): Promise<Array<Proc>> =>
  (
    (await herdr(socket, "pane.process_info", { pane_id: pane })) as {
      process_info: { foreground_processes?: Array<Proc> }
    }
  ).process_info.foreground_processes ?? []
const screen = async (socket: string, pane: string): Promise<string> =>
  ((await herdr(socket, "pane.read", { pane_id: pane, source: "visible" })) as { read: { text: string } }).read.text
/** The value after `flag` in a Claude process's argv in that pane, if one runs there. */
const claudeFlag = async (socket: string, pane: string, flag: string) => {
  for (const p of await foreground(socket, pane)) {
    const argv = p.argv ?? []
    const i = argv.indexOf(flag)
    if (argv.some((a) => /claude/.test(a)) && i !== -1) return argv[i + 1]
  }
  return undefined
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
  {
    id: "S10",
    title:
      "a Claude main agent in terminal A; `vibest` in terminal B answered y: A's harness ends and A keeps its shell, B resumes the same conversation",
    run: async (w) => {
      for (const bin of ["herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      // Its own herdr session and vibestd, with the user's Claude login (CLAUDE_CONFIG_DIR unset), as I4 does. An empty
      // ZDOTDIR keeps a pane's zsh from reading the user's zshrc, which can put an installed vibest ahead of this build.
      const session = `${w.herdrSession}-move`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      const zdot = path.join(w.root, "zdotdir-move")
      await fs.mkdir(zdot, { recursive: true })
      const env = { CLAUDE_CONFIG_DIR: undefined, ZDOTDIR: zdot }
      await w.stopDaemon()
      await w.ok(["daemon"], { env })
      try {
        await w.ok(["--harness", "claude", "--model", "haiku", "--session", session, "--headless"], {
          env,
          timeoutMs: 60_000,
        })
        // Terminal A: the one pane running Claude, started with the conversation id vibest chose (--session-id).
        let a = ""
        let conversation: string | undefined
        await until(
          "Claude in terminal A",
          async () => {
            const panes = (
              (await herdr(socket, "pane.list", {}).catch(() => ({ panes: [] }))) as {
                panes: Array<{ pane_id: string }>
              }
            ).panes
            for (const p of panes) {
              conversation = await claudeFlag(socket, p.pane_id, "--session-id")
              if (conversation) {
                a = p.pane_id
                return true
              }
            }
            return false
          },
          60_000,
        )
        // One turn, so Claude writes the conversation (vibest resumes only a conversation Claude wrote).
        const status = async (pane: string) =>
          ((await herdr(socket, "pane.get", { pane_id: pane })) as { pane: { agent_status: string } }).pane.agent_status
        await until(
          "Claude ready in A (its trust menu answered)",
          async () =>
            !(await trust(socket, a)) &&
            !/trust this folder/i.test(await screen(socket, a)) &&
            (await status(a)) === "idle",
          60_000,
        )
        await type(socket, a, "Do not use any tools. Reply with exactly: ok")
        const projects = path.join(w.home, ".claude", "projects")
        const written = async () => {
          for (const dir of await fs.readdir(projects).catch(() => [] as Array<string>))
            if (await Bun.file(path.join(projects, dir, `${conversation}.jsonl`)).exists()) return true
          return false
        }
        await until("A's conversation written", written, 120_000)
        await until("A idle after its turn", async () => (await status(a)) === "idle", 120_000)
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
        await type(socket, b, "vibest --harness claude --model haiku")
        await until(
          "B asks to move the main agent",
          async () => (await screen(socket, b)).includes("Move it here and continue? [y/N]"),
          60_000,
        )
        await type(socket, b, "y")
        await until("Claude resumed in B", async () => (await claudeFlag(socket, b, "--resume")) !== undefined, 60_000)
        expect(
          (await claudeFlag(socket, b, "--resume")) === conversation,
          `B resumed ${await claudeFlag(socket, b, "--resume")}, not ${conversation}`,
        )
        // A: its harness gone, the pane still there at its shell.
        await until("A's harness gone", async () => (await claudeFlag(socket, a, "--session-id")) === undefined, 20_000)
        const kept = ((await herdr(socket, "pane.list", {})) as { panes: Array<{ pane_id: string }> }).panes
        expect(
          kept.some((p) => p.pane_id === a),
          `pane ${a} closed`,
        )
        const shells = await foreground(socket, a)
        expect(
          shells.length > 0 && shells.every((p) => /^-?(zsh|bash|sh|fish)$/.test(path.basename(p.name))),
          `A runs ${JSON.stringify(shells)}`,
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
  },
]

export default checks
