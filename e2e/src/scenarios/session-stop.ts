import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { piDir, reply, text } from "../fake-model.ts"
import { alive, expect, row, rows, until } from "../world.ts"
import { entryIdOf, lastExecution, needs, recordingModel } from "./delivery.ts"
import { dropHerdrSession, project } from "./inbox.ts"

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  )

const checks: ReadonlyArray<Check> = [
  {
    id: "S66",
    title:
      "vibest stop on an idle subagent ends its harness process and closes its terminal, recorded as stopped by the session that ran it; vibest ls --all lists it as exited with its worktree kept; the next vibest send resumes the same conversation in a new terminal and is answered",
    run: async (w) => {
      needs()
      const model = recordingModel(() => reply("done-s66\nstatus: completed"))
      let session = ""

      type Process = { pid: number | null; terminal: string | null; conversation: string | null; reason: string | null }

      const processes = (id: string) =>
        rows<Process>(
          w,
          "SELECT pid, terminal, harness_session_id AS conversation, end_reason AS reason FROM process WHERE session_id = ? ORDER BY id",
          id,
        )

      const completedCount = (id: string) =>
        row<{ n: number }>(w, "SELECT count(*) AS n FROM execution WHERE session_id = ? AND outcome = 'completed'", id)
          ?.n ?? 0

      try {
        session = `${w.herdrSession}-s66`
        const repo = await project(w, "s66")
        const dir = await piDir(w, "pi-s66-sub", model.url)
        await w.entry({ cwd: repo, session, processEnv: { PI_CODING_AGENT_DIR: dir } })
        const entryId = entryIdOf(w)

        const id = (
          JSON.parse(
            await w.okViaEntry(["run", "pi", "--session", session, "--", "Remember the word s66-word-larch."], {
              cwd: repo,
              timeoutMs: 90_000,
            }),
          ) as { id: string }
        ).id

        await until("the first execution completed", () => lastExecution(w, id)?.status === "completed", 90_000)
        await until("Pi reported its conversation", () => processes(id).at(-1)?.conversation != null, 30_000)
        await until(
          "Pi saved the conversation",
          () => Bun.spawnSync(["grep", "-rl", "s66-word-larch", path.join(dir, "sessions")]).stdout.length > 0,
          30_000,
        )
        const first = processes(id).at(-1)!

        const stopped = JSON.parse(await w.okViaEntry(["stop", id], { cwd: repo, timeoutMs: 60_000 })) as {
          id: string
          message: string
        }

        expect(
          stopped.id === id && stopped.message.includes("stopped"),
          `vibest stop answered ${JSON.stringify(stopped)}`,
        )

        expect(processes(id).at(-1)?.reason === "stopped", `the process ended ${processes(id).at(-1)?.reason}`)

        const ended = rows<{ data: string }>(
          w,
          "SELECT data FROM event WHERE aggregate_id = ? AND type = 'process.ended.1' ORDER BY seq",
          id,
        ).map((r) => JSON.parse(r.data) as { reason: string; by?: { type?: string; session?: string } })

        expect(
          ended.at(-1)?.reason === "stopped" &&
            ended.at(-1)?.by?.type === "agent" &&
            ended.at(-1)?.by?.session === entryId,
          `process.ended recorded ${JSON.stringify(ended.at(-1))}, not stopped by ${entryId}`,
        )

        await until("the harness process ended", () => first.pid === null || !alive(first.pid), 30_000)

        const listed = (
          JSON.parse(await w.okViaEntry(["ls", "--all"], { cwd: repo })) as {
            sessions: Array<{ id: string; exitedAt: number | null; worktree: string }>
          }
        ).sessions.find((s) => s.id === id)

        expect(listed?.exitedAt != null, `vibest ls --all lists it as ${JSON.stringify(listed)}`)
        expect(await exists(listed!.worktree), `its worktree ${listed?.worktree} is gone`)

        await w.okViaEntry(["send", id, "--", "Which word did I give you?"], { cwd: repo })
        await until("the resumed execution completed", () => completedCount(id) === 2, 90_000)

        const resumed = processes(id).at(-1)!
        expect(
          resumed.terminal !== null &&
            resumed.terminal !== first.terminal &&
            resumed.conversation === first.conversation,
          `resumed as ${JSON.stringify(resumed)}; before the stop ${JSON.stringify(first)}`,
        )

        const last =
          model.requests
            .map((messages) => messages.map(text).join("\n"))
            .findLast((request) => request.includes("Which word did I give you?")) ?? ""

        expect(
          last.includes("s66-word-larch") && last.includes("Which word did I give you?"),
          `the resumed model call lost the conversation: ${last.slice(-800)}`,
        )
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
]

export default checks
