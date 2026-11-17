import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"

import type { Schema } from "effect"

import type { Check } from "../check.ts"
import { answerFolderTrust } from "../drivers/claude.ts"
import { claudeConfigOf, claudeEnv, fakeAnthropic, heldModel, piDir } from "../fake-model.ts"
import { expect, herdrPane, row, Skip, until } from "../world.ts"
import { alive } from "../world/alive.ts"

const herdr = (socket: string, method: string, params: Schema.JsonObject) =>
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

const screen = async (socket: string, pane: string): Promise<string> =>
  ((await herdr(socket, "pane.read", { pane_id: pane, source: "visible" })) as { read: { text: string } }).read.text

const type = async (socket: string, pane: string, text: string) => {
  await herdr(socket, "pane.send_text", { pane_id: pane, text })
  await herdr(socket, "pane.send_keys", { pane_id: pane, keys: ["enter"] })
}

const piWrote = async (agentDir: string, cwd: string) => {
  const real = await fs.realpath(cwd)
  const dir = path.join(agentDir, "sessions", `--${real.slice(1).replaceAll("/", "-")}--`)

  for (const file of await fs.readdir(dir).catch(() => [] as Array<string>)) {
    const text = await Bun.file(path.join(dir, file)).text()
    const head = JSON.parse(text.slice(0, text.indexOf("\n"))) as { cwd?: string }

    if (head.cwd === real && text.includes('"role":"assistant"')) return true
  }

  return false
}

const move = (harness: "claude" | "pi"): Check => ({
  id: harness === "claude" ? "S10" : "S10-pi",
  title: `a ${harness === "claude" ? "Claude" : "Pi"} entry session in terminal A; \`vibest\` in terminal B answered y: A's harness ends and A keeps its shell, B resumes the same conversation`,
  run: async (w) => {
    for (const bin of ["herdr", harness]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
    const pi = heldModel()
    pi.release()
    const claude = fakeAnthropic(() => "ok")
    const configTheResumeCheckReads = w.config.claude
    const claudeVars = await claudeEnv(w, "move", claude.url, configTheResumeCheckReads)
    const piAgentDir = await piDir(w, "pi-move", pi.url)
    const session = `${w.herdrSession}-move`
    const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
    const env = {}
    await w.daemon({ env })

    try {
      await w.startEntry({
        harness,
        session,
        env: harness === "claude" ? claudeVars : { PI_CODING_AGENT_DIR: piAgentDir },
        processEnv: env,
        timeoutMs: 60_000,
      })

      const entryProcess = () =>
        row<{
          session: string
          pid: number | null
          ready: number | null
          conversation: string | null
          terminal: string
        }>(
          w,
          `SELECT p.session_id AS session, p.pid, p.ready_at AS ready, p.conversation, p.terminal FROM process p
            JOIN project q ON q.entry_session_id = p.session_id
            WHERE p.ended_at IS NULL ORDER BY p.id DESC LIMIT 1`,
        )

      await until(`${harness} placed in terminal A`, () => entryProcess() !== undefined, 60_000)
      const a = herdrPane(entryProcess()!.terminal)!

      if (harness === "claude")
        await answerFolderTrust(
          () => screen(socket, a),
          (key) => herdr(socket, "pane.send_keys", { pane_id: a, keys: [key] }),
        )
      await until(`${harness} ready in A`, () => entryProcess()?.ready != null, 60_000)
      const first = entryProcess()!
      const prompt = "Do not use any tools. Reply with exactly: ok"
      await type(socket, a, prompt)
      let conversation: string | undefined
      const projects = path.join(claudeConfigOf(claudeVars), "projects")
      await until(
        "A's conversation written",
        async () => {
          if (harness === "pi") return await piWrote(piAgentDir, w.repository)
          conversation = entryProcess()?.conversation ?? undefined

          if (conversation === undefined) return false

          for (const dir of await fs.readdir(projects).catch(() => [] as Array<string>))
            if (await Bun.file(path.join(projects, dir, `${conversation}.jsonl`)).exists()) return true

          return false
        },
        120_000,
      )
      await until(
        "A's execution completed",
        () =>
          row<{ n: number }>(
            w,
            "SELECT count(*) AS n FROM execution WHERE session_id = ? AND outcome = 'completed'",
            first.session,
          )!.n > 0,
        120_000,
      )

      const b = (
        (await herdr(socket, "pane.split", {
          target_pane_id: a,
          direction: "right",
          cwd: w.repository,
          env: {
            PATH: w.env().PATH!,
            ...(harness === "claude" ? claudeVars : { PI_CODING_AGENT_DIR: piAgentDir }),
          },
          focus: false,
        })) as { pane: { pane_id: string } }
      ).pane.pane_id

      await until("B's shell", async () => /\S/.test(await screen(socket, b)), 30_000)
      await type(socket, b, `vibest --harness ${harness}`)
      await until(
        "B asks to move the entry session",
        async () => (await screen(socket, b)).includes("Move it here and continue? [y/N]"),
        60_000,
      )
      await type(socket, b, "y")

      if (harness === "claude") {
        await until("Claude resumed in B", () => herdrPane(entryProcess()?.terminal) === b, 60_000)
        await until("B reports its conversation", () => entryProcess()?.conversation != null, 60_000)
        const resumed = entryProcess()?.conversation
        expect(resumed === conversation, `B resumed ${resumed}, not ${conversation}`)
      } else {
        await until("Pi in B shows A's conversation", async () => (await screen(socket, b)).includes(prompt), 60_000)
      }

      await until("A's harness gone", () => !alive(first.pid!), 20_000)
      const kept = ((await herdr(socket, "pane.list", {})) as { panes: Array<{ pane_id: string }> }).panes
      expect(
        kept.some((p) => p.pane_id === a),
        `pane ${a} closed`,
      )

      const entryRows = (
        await w.json<{ sessions: Array<{ agent: string; address: { id: string } }> }>(["ls"]).then((l) => l.sessions)
      ).filter((e) => e.agent === "coordinator")

      expect(
        entryRows.length === 1 && entryRows[0]!.address.id.endsWith(b),
        `entry sessions: ${JSON.stringify(entryRows)}`,
      )
    } finally {
      pi.stop()
      claude.stop()
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

const checks: ReadonlyArray<Check> = [move("claude"), move("pi")]

export default checks
