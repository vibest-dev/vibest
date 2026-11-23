import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, holdsSlowMessageModel, piDir } from "../fake-model.ts"
import { alive, binary, expect, readDb, rows, SESSIONS, Skip, until } from "../world.ts"
import { isolatedCore } from "./hc.ts"
import { project } from "./inbox.ts"
import { oldInstall, type Row } from "./restart.ts"

const checks: ReadonlyArray<Check> = [
  {
    id: "U6-hc",
    covers: ["D7"],
    title:
      "vibest daemon restart onto another vibest restarts an old Pi entry session in place in its herdr-core terminal, on the same session and conversation as a new process, restarts its subagent too, both show idle once their harnesses report ready, and a subagent result still reaches it",
    run: async (w) => {
      for (const bin of ["pi", "hc", "python3"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = holdsSlowMessageModel()
      w.ownRuntimes.add("hc")
      await w.stopDaemon()
      const agentDir = await piDir(w, "pi-hc-restart", model.url)
      const core = await isolatedCore(w, agentDir, "hc-restart")

      try {
        const repo = await project(w, "hc-restart")
        const { old, wrapper, point, env } = await oldInstall(w, "hc-restart")
        const piEnv = `PI_CODING_AGENT_DIR=${agentDir}`

        const entry = () => {
          const db = readDb(path.join(w.vibestHome, "vibest.db"))

          try {
            return db
              .query<Row, [string]>(
                `SELECT s.id, s.harness_session_id, s.pid, s.version FROM ${SESSIONS} s
                 WHERE s.agent_type = 'coordinator' AND s.ended_at IS NULL AND s.directory = ?`,
              )
              .get(repo)
          } finally {
            db.close()
          }
        }

        const reached = (what: string, marker: string) =>
          until(
            what,
            () =>
              model.seen.some((m) => {
                const last = m.at(-1)!

                return last.includes("<agent-") && !last.includes("<title>entry</title>") && last.includes(marker)
              }),
            120_000,
          ).catch(async (e: Error) => {
            const log = await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")
            throw new Error(`${e.message}\nterminals:\n${await core.screens()}\nvibestd.log:\n${log.slice(-4000)}`)
          })

        const delegate = async (marker: string) => {
          const started = await w.okViaEntry(["run", "pi", "--runtime", "hc", "--env", piEnv, ask(marker)], {
            cwd: repo,
            env,
            bin: wrapper,
          })

          await reached(`the entry session's execution on the result of ${marker}`, `done-${marker}`)

          return (JSON.parse(started) as { id: string }).id
        }

        await w.startEntry({
          harness: "pi",
          runtime: "hc",
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: agentDir, PATH: env.PATH },
          extra: ["--runtime", "hc"],
          bin: wrapper,
          hc: { run: core.hc },
          timeoutMs: 60_000,
        })
        const sub = await delegate("zero")
        await until(
          "the entry session reports the old integration and its conversation",
          () => {
            const row = entry()

            return row?.version === old && row.harness_session_id !== null && row.pid !== null
          },
          60_000,
        )
        const before = entry()!

        await point(binary)
        const pty = ["python3", "-I", path.join(import.meta.dirname, "..", "terminal.py"), wrapper, "daemon", "restart"]
        const r = await w.run(repo, pty, { env, stdin: "y\ny\n", timeoutMs: 180_000 })
        const out = r.stdout.replace(/\r/g, "")
        expect(r.code === 0, `vibest daemon restart exited ${r.code}: ${out}${r.stderr}`)
        expect(
          out.includes("Restarting ") && out.includes(before.id.slice(0, 8)),
          `the entry session was not offered for a restart: ${out}`,
        )
        await until(
          "the entry session restarted on this integration",
          () => {
            const now = entry()

            return now?.pid != null && now.pid !== before.pid && now.version !== old && now.version !== null
          },
          120_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}: ${JSON.stringify(entry())}\nterminals:\n${await core.screens()}`)
        })
        const after = entry()!
        expect(after.id === before.id, `the entry session changed: ${before.id} -> ${after.id}`)
        expect(
          after.harness_session_id === before.harness_session_id,
          `the conversation changed: ${before.harness_session_id} -> ${after.harness_session_id}`,
        )
        expect(!alive(before.pid!), `the old harness ${before.pid} still runs`)

        const restarted = (id: string) =>
          rows<{ reason: string | null }>(w, "SELECT end_reason AS reason FROM process WHERE session_id = ?", id).some(
            (p) => p.reason === "restart",
          )

        expect(restarted(sub), `the subagent ${sub} was not restarted in place: ${out}`)

        const statuses = async () =>
          (await w.json<{ sessions: Array<{ id: string; status: string }> }>(["ls"], { cwd: repo })).sessions.filter(
            (s) => s.id === before.id || s.id === sub,
          )

        await until(
          "the entry session and the subagent idle once their restarted harnesses reported ready",
          async () => {
            const now = await statuses()

            return now.length === 2 && now.every((s) => s.status === "idle")
          },
          30_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}: ${JSON.stringify(await statuses())}\nterminals:\n${await core.screens()}`)
        })
        await delegate("after")

        const ends = rows<{ reason: string | null }>(
          w,
          "SELECT end_reason AS reason FROM process WHERE session_id = ? ORDER BY id",
          before.id,
        )

        expect(
          JSON.stringify(ends.map((e) => e.reason)) === '["restart",null]',
          `${before.id}'s processes: ${JSON.stringify(ends)}`,
        )
      } finally {
        model.stop()
        await w.stopDaemon()
        await core.stop()
      }
    },
  },
]

export default checks
