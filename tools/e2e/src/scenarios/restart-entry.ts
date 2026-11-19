import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, delegatingModel } from "../fake-model.ts"
import { binary, expect, EXECUTIONS, rows, SESSIONS, Skip, until } from "../world.ts"
import { claudeEntry } from "./inbox.ts"
import { oldInstall, type Row } from "./restart.ts"

const checks: ReadonlyArray<Check> = [
  {
    id: "U6-claude-entry",
    covers: ["D7"],
    title:
      "vibest daemon restart onto another vibest restarts an old Claude entry session in place with its subagent; afterwards the entry session runs on this integration and messages reach it: a send from the restarted subagent and a run through the entry session",
    run: async (w) => {
      for (const bin of ["claude", "pi", "herdr", "python3"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = delegatingModel("pi")
      const install = await oldInstall(w, "centry")
      const TITLE = "Answer probe"
      let c: Awaited<ReturnType<typeof claudeEntry>> | undefined

      try {
        c = await claudeEntry(w, "centry", model, () => "ok", install)

        const entry = () =>
          rows<Row>(
            w,
            `SELECT s.id, s.harness_session_id, s.pid, s.version FROM ${SESSIONS} s WHERE s.id = ?`,
            c!.entryId,
          )[0]

        await until(
          "the entry session reports the old integration",
          () => entry()?.version === install.old && entry()?.pid != null,
          120_000,
        )
        const sub = await c.start(TITLE, "cebefore")
        await c.result(sub, TITLE, "cebefore", 0)
        const before = entry()!

        await install.point(binary)

        const pty = [
          "python3",
          "-I",
          path.join(import.meta.dirname, "..", "terminal.py"),
          install.wrapper,
          "daemon",
          "restart",
        ]

        const r = await w.run(c.repo, pty, { env: install.env, stdin: "y\ny\n", timeoutMs: 180_000 })
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

            return now?.pid != null && now.pid !== before.pid && now.version !== install.old && now.version !== null
          },
          120_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}: ${JSON.stringify(entry())}; its screen:\n${await c!.screen()}`)
        })
        expect(
          entry()?.harness_session_id === before.harness_session_id,
          `the conversation changed: ${before.harness_session_id} -> ${entry()?.harness_session_id}`,
        )

        const after = c.delivered(sub)
        await w.ok(["send", sub, "--", ask("ceafter")], { cwd: c.repo, env: install.env })
        await c.result(sub, TITLE, "ceafter", after).catch(async (e: Error) => {
          const log = await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")

          const inbox = rows(
            w,
            "SELECT id, kind, status, sender_session_id FROM inbox WHERE session_id = ? ORDER BY id",
            c!.entryId,
          )

          const executions = rows(w, `SELECT * FROM ${EXECUTIONS} t WHERE session_id = ? ORDER BY id`, c!.entryId)
          throw new Error(
            `${e.message}\ninbox: ${JSON.stringify(inbox)}\nexecutions: ${JSON.stringify(executions)}\nvibestd.log:\n${log.slice(-6000)}`,
          )
        })
        await c.start("Second probe", "cesecond")
      } finally {
        model.stop()
        await c?.close()
      }
    },
  },
]

export default checks
