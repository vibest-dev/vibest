import fs from "node:fs/promises"

import type { Check } from "../check.ts"
import { ask, holdsSlowMessageModel, piDir } from "../fake-model.ts"
import { expect, row, rows, SESSIONS, Skip, until } from "../world.ts"
import { addressOf, isolatedCore } from "./hc.ts"
import { project } from "./inbox.ts"

type Process = { terminal: string | null; pid: number | null; ready: number | null; ended: number | null }

const checks: ReadonlyArray<Check> = [
  {
    id: "S58",
    title:
      "herdr-core runtime: a session keeps one terminal: a harness that exits before it reports ready leaves no terminal, a resume after an exit replaces the old terminal under the same name, and vibest archive closes the terminal of a session whose harness already exited",
    run: async (w) => {
      for (const bin of ["pi", "hc"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = holdsSlowMessageModel()
      w.ownRuntimes.add("hc")
      await w.stopDaemon()
      const agentDir = await piDir(w, "pi-hc-terminals", model.url)
      const core = await isolatedCore(w, agentDir, "hc-terminals")
      const piEnv = `PI_CODING_AGENT_DIR=${agentDir}`

      const current = (id: string) =>
        row<Process>(
          w,
          `SELECT terminal, pid, ready_at AS ready, ended_at AS ended FROM process
           WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
          id,
        )

      const terminalOf = (id: string) => addressOf(current(id)?.terminal ?? "@")

      const live = async (address: string) =>
        (await core.terminals()).some((t) => t.address === address && t.state === "live")

      const failing = async (what: string, e: Error) => {
        const log = await fs.readFile(`${w.vibestHome}/vibestd.log`, "utf8").catch(() => "")
        throw new Error(`${what}: ${e.message}\nterminals:\n${await core.screens()}\nvibestd.log:\n${log.slice(-4000)}`)
      }

      const exitOf = async (id: string) => {
        const pid = current(id)?.pid
        expect(pid !== null && pid !== undefined, `${id} reported no harness pid`)
        process.kill(pid!, "SIGTERM")
        await until(`${id}'s exit recorded`, () => current(id)?.ended !== null, 60_000).catch((e: Error) =>
          failing("exit", e),
        )
      }

      try {
        const repo = await project(w, "hc-terminals")
        await w.startEntry({
          harness: "pi",
          runtime: "hc",
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: agentDir },
          processEnv: { CLAUDE_CONFIG_DIR: undefined },
          extra: ["--runtime", "hc"],
          hc: { run: core.hc },
          timeoutMs: 60_000,
        })

        const run = (marker: string) =>
          w.okViaEntry(["run", "pi", "--runtime", "hc", "--env", piEnv, ask(marker)], { cwd: repo, timeoutMs: 90_000 })

        const a = (JSON.parse(await run("one")) as { id: string }).id
        await until("the subagent ready", () => (current(a)?.ready ?? null) !== null, 90_000).catch((e: Error) =>
          failing("start", e),
        )
        const first = terminalOf(a)
        const name = (await core.get(first)).name
        await exitOf(a)
        expect(await live(first), `the exited harness left no shell in ${first}, so nothing here reproduces`)

        await w.okViaEntry(["send", a, "--", ask("two")], { cwd: repo })
        await until(
          "the resumed subagent ready in a new terminal",
          () => {
            const now = current(a)

            return now?.ready !== null && now?.ended === null && terminalOf(a) !== first
          },
          90_000,
        ).catch((e: Error) => failing("resume", e))
        const second = terminalOf(a)
        expect(!(await live(first)), `the resume left the old terminal ${first} live beside ${second}`)
        const renamed = (await core.get(second)).name
        expect(renamed === name, `the resumed terminal is named ${renamed}, not ${name}`)

        await exitOf(a)
        expect(await live(second), `the exited harness left no shell in ${second}, so nothing here reproduces`)
        const worktree = row<{ d: string }>(w, "SELECT directory AS d FROM session WHERE id = ?", a)?.d ?? ""
        const archived = await w.vibest(["archive", a], { cwd: repo, timeoutMs: 60_000 })
        const said = `${archived.stdout}${archived.stderr}`
        expect(archived.code === 0, `vibest archive exited ${archived.code}: ${said}`)
        expect(!(await live(second)), `vibest archive left the terminal ${second} of exited ${a}: ${said}`)
        expect(
          !(await fs.stat(worktree).then(
            () => true,
            () => false,
          )),
          `vibest archive kept the worktree ${worktree}: ${said}`,
        )

        const killedBeforeReady = async (marker: string) => {
          const known = new Set(rows<{ id: string }>(w, "SELECT id FROM session").map((r) => r.id))
          const starting = run(marker).catch(() => "")
          const deadline = Date.now() + 60_000
          let id: string | undefined
          let killed = false

          while (!killed && Date.now() < deadline) {
            id ??= rows<{ id: string }>(w, "SELECT id FROM session").find((r) => !known.has(r.id))?.id

            if (id !== undefined && (current(id)?.ready ?? null) !== null) break

            if (id !== undefined) {
              const listed = await w.run(repo, ["ps", "-axo", "pid=,command="], { unlogged: true })

              for (const line of listed.stdout.split("\n").filter((l) => l.includes(`vibest/${id}/`))) {
                try {
                  process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL")
                  killed = true
                } catch {}
              }
            }

            await Bun.sleep(20)
          }

          await starting

          return killed ? id : undefined
        }

        let b: string | undefined

        for (let attempt = 0; b === undefined && attempt < 5; attempt++) {
          const tried = await killedBeforeReady(`three-${attempt}`)

          if (tried === undefined) continue
          await until(`${tried}'s exit recorded`, () => current(tried)?.ended !== null, 180_000).catch((e: Error) =>
            failing("unconfirmed exit", e),
          )

          if (current(tried)?.ready === null) b = tried
        }

        if (b === undefined) throw new Error("every new subagent reported ready before its harness could be killed")
        const placed = terminalOf(b)
        await until(
          `the terminal ${placed} of ${b}, whose start was never confirmed, closed`,
          async () => !(await live(placed)),
          30_000,
        ).catch((e: Error) => failing("unconfirmed terminal", e))
        expect(
          rows<{ id: string }>(w, `SELECT id FROM ${SESSIONS} s WHERE id = ? AND exited_at IS NOT NULL`, b).length ===
            1,
          `${b} is not recorded as exited`,
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
