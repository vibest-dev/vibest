import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"

import type { Check } from "../check.ts"
import { answerFolderTrust } from "../drivers/claude.ts"
import { claudeConfigOf, claudeEnv, fakeAnthropic, heldModel, piDir } from "../fake-model.ts"
import { expect, fail, row, SESSIONS, Skip, until } from "../world.ts"

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
const harnessArgv = async (socket: string, pane: string, harness: "claude" | "pi") => {
  for (const p of await foreground(socket, pane)) {
    const argv = p.argv ?? []
    const programNames = [p.name, p.argv0 ?? "", ...argv.slice(0, harness === "pi" ? 2 : 1)]
    if (programNames.some((n) => (harness === "claude" ? /claude/.test(n) : path.basename(n) === "pi"))) return argv
  }
  return undefined
}
const harnessFlag = async (socket: string, pane: string, harness: "claude" | "pi", flag: string) => {
  const argv = (await harnessArgv(socket, pane, harness)) ?? []
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}
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
      ).catch(async (e: Error) => {
        const panes = (
          (await herdr(socket, "pane.list", {}).catch(() => ({ panes: [] }))) as { panes: Array<{ pane_id: string }> }
        ).panes
        const seen = await Promise.all(
          panes.map(
            async (p) =>
              `${p.pane_id}: ${JSON.stringify(await foreground(socket, p.pane_id))}\n${await screen(socket, p.pane_id)}`,
          ),
        )
        fail(`${e.message}; panes:\n${seen.join("\n")}`)
      })
      const status = async (pane: string) =>
        ((await herdr(socket, "pane.get", { pane_id: pane })) as { pane: { agent_status: string } }).pane.agent_status
      if (harness === "claude")
        await answerFolderTrust(
          () => screen(socket, a),
          (key) => herdr(socket, "pane.send_keys", { pane_id: a, keys: [key] }),
        )
      await until(`${harness} ready in A`, async () => (await status(a)) === "idle", 60_000)
      const prompt = "Do not use any tools. Reply with exactly: ok"
      await herdr(socket, "agent.prompt", { target: a, text: prompt })
      let conversation: string | undefined
      const projects = path.join(claudeConfigOf(claudeVars), "projects")
      const realRepository = await fs.realpath(w.repository)
      await until(
        "A's conversation written",
        async () => {
          if (harness === "pi") return await piWrote(piAgentDir, w.repository)
          conversation =
            row<{ c: string | null }>(
              w,
              `SELECT s.harness_session_id AS c FROM ${SESSIONS} s
               WHERE s.agent_type = 'main' AND s.directory = ? AND s.ended_at IS NULL`,
              realRepository,
            )?.c ?? undefined
          if (conversation === undefined) return false
          for (const dir of await fs.readdir(projects).catch(() => [] as Array<string>))
            if (await Bun.file(path.join(projects, dir, `${conversation}.jsonl`)).exists()) return true
          return false
        },
        120_000,
      )
      const idleOrUnseenExecutionDone = ["idle", "done"]
      await until(
        "A idle after its execution",
        async () => idleOrUnseenExecutionDone.includes(await status(a)),
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
        await until(
          "Claude resumed in B",
          async () => (await harnessFlag(socket, b, "claude", "--resume")) !== undefined,
          60_000,
        ).catch(async (e: Error) =>
          fail(
            `${e.message}; B runs ${JSON.stringify(await foreground(socket, b))}; its screen:\n${await screen(socket, b)}`,
          ),
        )
        const resumed = await harnessFlag(socket, b, "claude", "--resume")
        expect(resumed === conversation, `B resumed ${resumed}, not ${conversation}`)
      } else {
        await until("Pi in B shows A's conversation", async () => (await screen(socket, b)).includes(prompt), 60_000)
      }
      await until("A's harness gone", async () => (await harnessArgv(socket, a, harness)) === undefined, 20_000)
      const kept = ((await herdr(socket, "pane.list", {})) as { panes: Array<{ pane_id: string }> }).panes
      expect(
        kept.some((p) => p.pane_id === a),
        `pane ${a} closed`,
      )
      const shellOnly = async () => {
        const procs = await foreground(socket, a)
        return procs.length > 0 && procs.every((p) => /^-?(zsh|bash|sh|fish)$/.test(path.basename(p.name)))
      }
      await until("only a shell in A", shellOnly, 30_000).catch(async () =>
        fail(`A runs ${JSON.stringify(await foreground(socket, a))}`),
      )
      const entryRows = (
        await w.json<{ sessions: Array<{ agent: string; address: { id: string } }> }>(["ls"]).then((l) => l.sessions)
      ).filter((e) => e.agent === "main")
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
