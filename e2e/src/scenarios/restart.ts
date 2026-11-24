import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { answerFolderTrust, typeAndEnter } from "../drivers/claude.ts"
import {
  ask,
  claudeEnv,
  envArgs,
  fakeAnthropic,
  holdsSlowMessageModel,
  lastUser,
  piDir,
  text,
  usageLimitedModel,
} from "../fake-model.ts"
import {
  paneOf,
  alive,
  binary,
  compiled,
  expect,
  expectFacts,
  harnesses,
  herdr,
  readDb,
  rows,
  SESSIONS,
  Skip,
  EXECUTIONS,
  until,
  type World,
} from "../world.ts"
import { piShadow } from "../world/shadow.ts"
import { dropHerdrSession, project } from "./inbox.ts"

export type Row = { id: string; harness_session_id: string | null; pid: number | null; version: string | null }

const OLD = "0.0.0-old"

const ensureRuntime = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (args.includes("--runtime")) return args

  if (args[0] === "run") return ["run", "--runtime", "herdr", ...args.slice(1)]

  if (args.length === 0 || (args[0]!.startsWith("-") && args[0] !== "--version" && args[0] !== "--help"))
    return ["--runtime", "herdr", ...args]

  return args
}

export const oldInstall = async (w: World, name: string) => {
  const old = path.join(w.root, `${name}-old`)
  await fs.mkdir(path.join(old, "bin"), { recursive: true })
  await fs.copyFile(compiled, path.join(old, "bin", "vibest"))
  await fs.chmod(path.join(old, "bin", "vibest"), 0o755)
  await fs.cp(harnesses, path.join(old, "harnesses"), { recursive: true })

  const patch = async (file: string, from: RegExp, to: string) => {
    const source = await fs.readFile(file, "utf8")
    const patched = source.replace(from, to)
    expect(patched !== source, `${file}: its version was not found`)
    await fs.writeFile(file, patched)
  }

  await patch(path.join(old, "harnesses", "pi", "extension.mjs"), /var VERSION = "[^"]+";/, `var VERSION = "${OLD}";`)
  await patch(
    path.join(old, "harnesses", "claude", "hooks", "register.mjs"),
    /pluginVersion: "[^"]+"/,
    `pluginVersion: "${OLD}"`,
  )
  const bin = path.join(w.root, `${name}-bin`)
  await fs.mkdir(bin, { recursive: true })
  const wrapper = path.join(bin, "vibest")
  const point = (target: string) => fs.writeFile(wrapper, `#!/bin/sh\nexec '${target}' "$@"\n`, { mode: 0o755 })
  await point(path.join(old, "bin", "vibest"))

  return { old: OLD, wrapper, point, env: { PATH: `${bin}:${w.env().PATH}` } }
}

const usageLimited = async (
  w: World,
  o: { readonly name: string; readonly limited: (path: string) => boolean },
  body: (m: {
    readonly id: string
    readonly seen: ReadonlyArray<string>
    readonly row: () => { harness: string; provider: string | null; pid: number | null; conversation: string | null }
    readonly status: () => ReadonlyArray<{ status: string }>
    readonly pane: () => string | undefined
    readonly log: () => Promise<string>
  }) => Promise<void>,
) => {
  for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
  const model = usageLimitedModel(o.limited)
  const session = `${w.herdrSession}-${o.name}`

  try {
    const repo = await project(w, o.name)
    const base = `http://127.0.0.1:${model.port}`

    const agentDir = await piShadow(
      path.join(w.root, `pi-${o.name}`),
      w.profile,
      { first: { baseUrl: `${base}/v1` } },
      undefined,
    )

    const env = { PI_CODING_AGENT_DIR: agentDir }
    await w.entry({ cwd: repo, session, processEnv: env })

    const id = (
      JSON.parse(
        await w.okViaEntry(["run", "pi", "--provider", "first", "--model", "m", "--session", session, ask("limit")], {
          cwd: repo,
          env,
          timeoutMs: 120_000,
        }),
      ) as { id: string }
    ).id

    const read = <A>(sql: string) => {
      const db = readDb(path.join(w.vibestHome, "vibest.db"))

      try {
        return db.query<A, [string]>(sql).all(id)
      } finally {
        db.close()
      }
    }

    await body({
      id,
      seen: model.seen,
      row: () =>
        read<{ harness: string; provider: string | null; pid: number | null; conversation: string | null }>(
          `SELECT harness, provider, pid, harness_session_id AS conversation FROM ${SESSIONS} s WHERE id = ?`,
        )[0]!,
      status: () => read<{ status: string }>(`SELECT status FROM ${EXECUTIONS} t WHERE session_id = ? ORDER BY id`),
      pane: () => paneOf(w, id),
      log: async () => (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")).slice(-4000),
    })
  } finally {
    model.stop()
    await dropHerdrSession(w, session)
  }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "U2",
    covers: ["D8"],
    title:
      "vibest update: vibestd hands over; No keeps an old Pi entry session mid-execution (its old protocol is told to run vibest update), Yes restarts its Pi subagent in its pane and then it in its pane on the same session and conversation, its inbox continues the execution, and messages still arrive",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "python3"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = holdsSlowMessageModel()
      const session = `${w.herdrSession}-restart`

      try {
        const repo = await project(w, "restart")
        const agentDir = await piDir(w, "pi-restart", model.url)
        const { old, wrapper, point, env } = await oldInstall(w, "restart")
        const piEnv = `PI_CODING_AGENT_DIR=${agentDir}`

        const viaEntry = (args: ReadonlyArray<string>) =>
          w.okViaEntry(ensureRuntime(args), { cwd: repo, env, bin: wrapper })

        const read = (where: string, arg: string) => {
          const db = readDb(path.join(w.vibestHome, "vibest.db"))

          try {
            return db
              .query<Row, [string]>(
                `SELECT s.id, s.harness_session_id, s.pid, s.version FROM ${SESSIONS} s WHERE ${where}`,
              )
              .get(arg)
          } finally {
            db.close()
          }
        }

        const entryId = () =>
          read(`s.agent_type = 'coordinator' AND s.ended_at IS NULL AND s.directory LIKE ?`, `%/${path.basename(repo)}`)

        const subRow = (id: string) => read("s.id = ?", id)

        const reached = (what: string, ok: (messages: ReadonlyArray<string>) => boolean) =>
          until(what, () => model.seen.some(ok), 120_000).catch(async (e: Error) => {
            const log = await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")
            throw new Error(
              `${e.message}; the model saw: ${JSON.stringify(
                model.seen.map((m) => m.at(-1)),
                null,
                1,
              )}\nvibestd.log:\n${log.slice(-4000)}`,
            )
          })

        const result = (marker: string) => (m: ReadonlyArray<string>) =>
          m.at(-1)!.includes("<vibest-agent-message>") && m.at(-1)!.includes(marker)

        await w.stopDaemon()
        await w.startEntry({
          harness: "pi",
          session,
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: agentDir },
          processEnv: env,
          bin: wrapper,
          timeoutMs: 60_000,
        })

        const zero = (
          JSON.parse(await viaEntry(["run", "pi", "--session", session, "--env", piEnv, ask("zero")])) as { id: string }
        ).id

        await reached("the entry session's execution on the first message", result("done-zero"))
        await until("the subagent reports the old integration", () => {
          const row = subRow(zero)

          return row?.version === old && row.pid !== null
        })
        const subBefore = subRow(zero)!
        const subPane = paneOf(w, zero)
        await until(
          "the entry session reports the old integration and its conversation",
          () => {
            const row = entryId()

            return row?.version === old && row.harness_session_id !== null && row.pid !== null
          },
          60_000,
        )
        const before = entryId()!
        const daemonBefore = await w.daemonPid()

        const address = async () =>
          (
            await w
              .json<{ sessions: Array<{ id: string; terminal: unknown }> }>(["ls"], { cwd: repo, env })
              .then((l) => l.sessions)
          ).find((e) => e.id === before.id)?.terminal

        const addressBefore = await address()
        await viaEntry(["run", "pi", "--session", session, "--env", piEnv, ask("slow")])
        await until("the entry session's held execution", () => model.held() > 0, 120_000)

        await point(binary)

        const update = async (answer: string) => {
          const pty = ["python3", "-I", path.join(import.meta.dirname, "..", "terminal.py"), wrapper, "update"]
          const r = await w.run(repo, pty, { env, stdin: `${answer}\n`, timeoutMs: 180_000 })
          const out = r.stdout.replace(/\r/g, "")
          expect(r.code === 0, `vibest update (${answer}) exited ${r.code}: ${out}${r.stderr}`)

          return out
        }

        const no = await update("n")
        expect(no.includes("vibestd handed over; agents kept running"), `vibestd was not handed over: ${no}`)
        expect(no.includes("They keep the old integration"), `No did not keep the agent: ${no}`)
        const daemonAfter = await w.daemonPid()
        expect(daemonAfter !== undefined && daemonAfter !== daemonBefore, `vibestd ${daemonBefore} -> ${daemonAfter}`)
        const kept = entryId()
        expect(
          kept?.pid === before.pid && alive(before.pid!),
          `No restarted the entry session: ${JSON.stringify(kept)}`,
        )
        expect(kept?.version === old, `the kept agent's integration: ${kept?.version}`)

        const refused = await fetch("http://vibestd/inbox/take", {
          unix: path.join(w.vibestHome, "vibest-http.sock"),
          method: "POST",
          headers: { "vibest-protocol": "2", "vibest-session-id": before.id },
          body: "{}",
        } as RequestInit)

        const answer = (await refused.json()) as { error?: string; action?: string }
        expect(
          refused.status === 409 && answer.action === "vibest update" && /vibest update/.test(answer.error ?? ""),
          `an old protocol's call got ${refused.status} ${JSON.stringify(answer)}`,
        )

        const yes = await update("y")
        expect(
          yes.includes("Restarting ") && yes.includes(before.id.slice(0, 8)) && yes.includes(zero.slice(0, 8)),
          `the agents were not handed to vibestd for a restart: ${yes}`,
        )
        expect((await w.daemonPid()) === daemonAfter, `vibestd changed again on the second update: ${yes}`)
        await until(
          "the subagent restarted on this integration",
          () => {
            const row = subRow(zero)

            return row?.pid != null && row.pid !== subBefore.pid && row.version !== old && row.version !== null
          },
          120_000,
        )
        expect(!alive(subBefore.pid!), `the subagent's old harness ${subBefore.pid} still runs`)
        expect(
          subRow(zero)?.harness_session_id === subBefore.harness_session_id,
          `the subagent's conversation changed: ${subBefore.harness_session_id} -> ${subRow(zero)?.harness_session_id}`,
        )
        expect(paneOf(w, zero) === subPane, `the subagent's pane changed: ${subPane} -> ${paneOf(w, zero)}`)
        let after = null as ReturnType<typeof entryId>
        await until(
          "the entry session restarted on this integration",
          () => {
            after = entryId()

            return after?.pid != null && after.pid !== before.pid && after.version !== old && after.version !== null
          },
          120_000,
        )
        expect(after?.id === before.id, `the entry session's session changed: ${before.id} -> ${after?.id}`)
        expect(
          after?.harness_session_id === before.harness_session_id,
          `the conversation changed: ${before.harness_session_id} -> ${after?.harness_session_id}`,
        )
        expect(after?.pid !== before.pid, `the harness pid did not change (${before.pid})`)
        expect(!alive(before.pid!), `the old harness ${before.pid} still runs`)
        await until("the restarted entry session reports this integration", () => entryId()?.version !== old, 30_000)
        expect(
          JSON.stringify(await address()) === JSON.stringify(addressBefore),
          `the entry session's terminal changed: ${JSON.stringify(addressBefore)} -> ${JSON.stringify(await address())}`,
        )
        await reached(
          "the continue notice of the interrupted execution, with the earlier executions",
          (m) =>
            /^user: .*"text":"(<vibest-message>\\n<message>\\n)?vibest update is done and restarted this agent; do not run it again, continue the interrupted work\./.test(
              m.at(-1)!,
            ) &&
            m.some((x) => x.includes("done-zero")) &&
            m.some((x) => x.includes("done-slow")),
        )
        await viaEntry(["run", "pi", "--session", session, "--env", piEnv, ask("after")])
        await reached("the entry session's execution on a message after the update", result("done-after"))

        for (const id of [before.id, zero]) {
          expectFacts(w, id, ["process.started", "process.ended", "process.started", "process.ready"])

          const ends = rows<{ reason: string | null }>(
            w,
            "SELECT end_reason AS reason FROM process WHERE session_id = ? ORDER BY id",
            id,
          )

          expect(
            JSON.stringify(ends.map((e) => e.reason)) === '["restart",null]',
            `${id}'s processes: ${JSON.stringify(ends)}`,
          )
        }
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "U6",
    covers: ["D7"],
    title:
      "vibest daemon restart onto another vibest: Yes to both questions replaces vibestd and restarts an old Pi subagent in place, in the same pane on the same conversation, as a new process; a late execution end from the old process is dropped",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "python3"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = holdsSlowMessageModel()
      const session = `${w.herdrSession}-drestart`

      try {
        const repo = await project(w, "drestart")
        const agentDir = await piDir(w, "pi-drestart", model.url)
        const { old, wrapper, point, env } = await oldInstall(w, "drestart")

        const ok = async (args: ReadonlyArray<string>) => {
          const r = await w.run(repo, [wrapper, ...ensureRuntime(args)], { env, timeoutMs: 60_000 })
          expect(r.code === 0, `vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)

          return r.stdout
        }

        const viaEntry = (args: ReadonlyArray<string>) =>
          w.okViaEntry(ensureRuntime(args), { cwd: repo, env, bin: wrapper })

        const row = (id: string) => {
          const db = readDb(path.join(w.vibestHome, "vibest.db"))

          try {
            return db
              .query<Row, [string]>(
                `SELECT s.id, s.harness_session_id, s.pid, s.version FROM ${SESSIONS} s WHERE s.id = ?`,
              )
              .get(id)
          } finally {
            db.close()
          }
        }

        await w.stopDaemon()
        await ok(["daemon"])
        await w.entry({ cwd: repo, session, processEnv: env })

        const id = (
          JSON.parse(
            await viaEntry(["run", "pi", "--session", session, "--env", `PI_CODING_AGENT_DIR=${agentDir}`, ask("one")]),
          ) as { id: string }
        ).id

        await until(
          "the subagent reports the old integration and its conversation",
          () => {
            const r = row(id)

            return r?.version === old && r.pid !== null && r.harness_session_id !== null
          },
          120_000,
        )
        const before = row(id)!

        const processOf = () =>
          rows<{ process: number }>(w, "SELECT process_id AS process FROM session WHERE id = ?", id)[0]?.process

        const oldProcess = processOf()
        const pane = paneOf(w, id)
        const daemonBefore = await w.daemonPid()

        await point(binary)
        const pty = ["python3", "-I", path.join(import.meta.dirname, "..", "terminal.py"), wrapper, "daemon", "restart"]
        const r = await w.run(repo, pty, { env, stdin: "y\ny\n", timeoutMs: 180_000 })
        const out = r.stdout.replace(/\r/g, "")
        expect(r.code === 0, `vibest daemon restart exited ${r.code}: ${out}${r.stderr}`)
        expect(
          /Restart (it|these \d+ agents) in place and continue (its conversation|their conversations)\? \[Y\/n\]/.test(
            out,
          ) &&
            out.includes("Restarting ") &&
            out.includes(id.slice(0, 8)),
          `the subagent was not offered for a restart: ${out}`,
        )
        const daemonAfter = await w.daemonPid()
        expect(daemonAfter !== undefined && daemonAfter !== daemonBefore, `vibestd ${daemonBefore} -> ${daemonAfter}`)
        await until(
          "the subagent restarted on this integration",
          () => {
            const now = row(id)

            return now?.pid != null && now.pid !== before.pid && now.version !== old && now.version !== null
          },
          120_000,
        )
        expect(!alive(before.pid!), `the subagent's old harness ${before.pid} still runs`)
        expect(
          row(id)?.harness_session_id === before.harness_session_id,
          `the conversation changed: ${before.harness_session_id} -> ${row(id)?.harness_session_id}`,
        )
        expect(paneOf(w, id) === pane, `the subagent's pane changed: ${pane} -> ${paneOf(w, id)}`)
        expect(processOf() !== oldProcess, `the restarted subagent is still process ${oldProcess}`)
        const LATE = "a late reply from the harness the restart replaced"

        const late = await w.run(repo, [wrapper, "integration", "stop", "--harness", "pi"], {
          env: { ...env, VIBEST_SESSION_ID: id, VIBEST_PROCESS: String(oldProcess) },
          stdin: JSON.stringify({ type: "agent_settled", text: LATE, error: "", aborted: false }),
        })

        expect(late.code === 0, `the old process's execution end was not taken: ${late.stderr}`)
        expect(
          rows(w, "SELECT id FROM execution WHERE session_id = ? AND reply = ?", id, LATE).length === 0,
          "the old process's late execution end was recorded",
        )
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "U6-claude",
    covers: ["D7"],
    title:
      "vibest daemon restart onto another vibest restarts an old Claude subagent in place during its first execution: it resumes the same conversation in the same pane and completes the execution",
    run: async (w) => {
      for (const bin of ["claude", "pi", "herdr", "python3"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const TASK = "first-execution-of-u6-claude"
      const DONE = "done-u6-claude"
      const CONTINUE = "continue the interrupted work"
      let held = 0

      const model = fakeAnthropic(async (r) => {
        if (r.tools.length === 0) return "ok"
        const said = r.messages.filter((m) => m.role === "user").map(text)

        if (said.some((m) => m.includes(CONTINUE))) return DONE

        if (said.some((m) => m.includes(TASK))) {
          held++
          await new Promise(() => {})
        }

        return "ok"
      })

      const session = `${w.herdrSession}-crestart`

      try {
        const repo = await project(w, "crestart")
        const { old, wrapper, point, env } = await oldInstall(w, "crestart")

        const ok = async (args: ReadonlyArray<string>) => {
          const r = await w.run(repo, [wrapper, ...ensureRuntime(args)], { env, timeoutMs: 60_000 })
          expect(r.code === 0, `vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)

          return r.stdout
        }

        const row = (id: string) => {
          const db = readDb(path.join(w.vibestHome, "vibest.db"))

          try {
            return db
              .query<Row, [string]>(
                `SELECT s.id, s.harness_session_id, s.pid, s.version FROM ${SESSIONS} s WHERE s.id = ?`,
              )
              .get(id)
          } finally {
            db.close()
          }
        }

        await w.stopDaemon()
        await ok(["daemon"])
        await w.entry({ cwd: repo, session, processEnv: env })

        const id = (
          JSON.parse(
            await w.okViaEntry(
              ensureRuntime([
                "run",
                "claude",
                "--session",
                session,
                ...envArgs(await claudeEnv(w, "crestart", model.url)),
                "--",
                `Work on ${TASK}.`,
              ]),
              { cwd: repo, env, bin: wrapper },
            ),
          ) as { id: string }
        ).id

        const accepted = () =>
          rows<{ n: number }>(
            w,
            "SELECT count(*) AS n FROM execution WHERE session_id = ? AND started_at IS NOT NULL AND outcome IS NULL",
            id,
          )[0]?.n === 1

        await until(
          "the Claude subagent on the old integration, mid-way through its first execution",
          () => {
            const r = row(id)

            return r?.version === old && r.pid !== null && r.harness_session_id !== null && held > 0 && accepted()
          },
          120_000,
        )
        const before = row(id)!
        const pane = paneOf(w, id)

        await point(binary)
        const pty = ["python3", "-I", path.join(import.meta.dirname, "..", "terminal.py"), wrapper, "daemon", "restart"]
        const r = await w.run(repo, pty, { env, stdin: "y\ny\n", timeoutMs: 180_000 })
        const out = r.stdout.replace(/\r/g, "")
        expect(r.code === 0, `vibest daemon restart exited ${r.code}: ${out}${r.stderr}`)
        expect(
          out.includes("Restarting ") && out.includes(id.slice(0, 8)),
          `the Claude subagent was not offered for a restart: ${out}`,
        )

        const outcomes = () =>
          rows<{ outcome: string | null; reply: string | null }>(
            w,
            "SELECT outcome, reply FROM execution WHERE session_id = ? ORDER BY id",
            id,
          )

        await until(
          "the restarted Claude subagent completes its first execution",
          () => outcomes().some((e) => e.outcome === "completed" && (e.reply ?? "").includes(DONE)),
          120_000,
        ).catch(async (e: Error) => {
          const log = await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")
          throw new Error(
            `${e.message}; its executions: ${JSON.stringify(outcomes())}\nvibestd.log:\n${log.slice(-4000)}`,
          )
        })
        const after = row(id)
        expect(
          after?.pid != null && after.pid !== before.pid && after.version !== old,
          `the subagent did not restart on this integration: ${JSON.stringify(after)}`,
        )
        expect(!alive(before.pid!), `the subagent's old harness ${before.pid} still runs`)
        expect(
          after?.harness_session_id === before.harness_session_id,
          `the conversation changed: ${before.harness_session_id} -> ${after?.harness_session_id}`,
        )
        expect(paneOf(w, id) === pane, `the subagent's pane changed: ${pane} -> ${paneOf(w, id)}`)
        expect(
          model.requests.some((q) => {
            const said = q.messages.map(text)

            return said.some((m) => m.includes(CONTINUE)) && said.some((m) => m.includes(TASK))
          }),
          "the restarted Claude did not continue the conversation that held its task",
        )
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "U4",
    covers: ["D8"],
    title:
      "vibest update run by a Claude entry session (fake model) is refused: the tool result says it is for the user, the session keeps running on the same process and conversation, and nothing is installed or restarted",
    run: async (w) => {
      for (const bin of ["herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const session = `${w.herdrSession}-cupdate`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      const UPDATE = "Run vibest update --yes now."
      let updates = 0

      const model = fakeAnthropic((r) => {
        const last = text(lastUser(r))

        if (last.includes(UPDATE)) {
          if (r.tools.length > 0) updates++

          return { tool: "Bash", input: { command: "vibest update --yes" } }
        }

        return last.includes('"tool_result"') ? "UPDATED" : "ok"
      })

      try {
        const repo = await project(w, "claude-update")
        const install = await oldInstall(w, "cupdate")
        const configTheResumeCheckReads = w.config.claude
        const flags = await claudeEnv(w, "cupdate", model.url, configTheResumeCheckReads)

        const vibest = async (args: ReadonlyArray<string>, timeoutMs = 120_000) => {
          const r = await w.run(repo, [install.wrapper, ...ensureRuntime(args)], { env: install.env, timeoutMs })
          expect(r.code === 0, `vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)

          return r.stdout
        }

        type EntryRow = {
          id: string
          conversation: string | null
          runtime: string
          pid: number | null
          version: string | null
        }

        const entryId = () => {
          const db = readDb(path.join(w.vibestHome, "vibest.db"))

          try {
            return (
              db
                .query<EntryRow, [string]>(
                  `SELECT id, harness_session_id AS conversation, runtime, pid, version
                   FROM ${SESSIONS} s WHERE agent_type = 'coordinator' AND ended_at IS NULL AND directory = ?`,
                )
                .get(repo) ?? undefined
            )
          } finally {
            db.close()
          }
        }

        const pane = () => ((JSON.parse(entryId()?.runtime ?? "{}") as { id?: string }).id ?? "").split("/")[1] ?? ""

        const screen = async () => {
          const r = await herdr(socket, "pane.read", { pane_id: pane(), source: "visible", strip_ansi: true })

          return String((r.read as { text?: string } | undefined)?.text ?? "")
        }

        const log = async () =>
          (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")).slice(-4000)

        const failWith = async (e: Error) => {
          throw new Error(`${e.message}; row ${JSON.stringify(entryId())}; screen:\n${await screen()}\n${await log()}`)
        }

        await w.stopDaemon()
        await vibest(["daemon"])
        await w.startEntry({
          harness: "claude",
          session,
          cwd: repo,
          env: flags,
          processEnv: install.env,
          bin: install.wrapper,
          timeoutMs: 120_000,
        })
        await until("the entry session's row", () => pane() !== "", 60_000)
        await answerFolderTrust(screen, (key) => herdr(socket, "pane.send_keys", { pane_id: pane(), keys: [key] }))
        await until(
          "the entry session polls on the old integration",
          () => entryId()?.version === install.old && entryId()?.conversation != null && entryId()?.pid != null,
          120_000,
        ).catch(failWith)
        const before = entryId()!

        await typeAndEnter(
          screen,
          {
            text: (text) => herdr(socket, "pane.send_text", { pane_id: pane(), text }),
            enter: () => herdr(socket, "pane.send_keys", { pane_id: pane(), keys: ["enter"] }),
          },
          UPDATE,
        )

        await until(
          "the refusal reached the model",
          () => model.requests.some((r) => text(lastUser(r)).includes("Forbidden")),
          120_000,
        ).catch(failWith)
        await until("the entry session replies", async () => /[⏺●] UPDATED/.test(await screen()), 120_000).catch(
          failWith,
        )
        expect(updates === 1, `vibest update was asked for ${updates} times`)
        expect(entryId()?.pid === before.pid && alive(before.pid!), "the entry session's harness was restarted")
        expect(entryId()?.conversation === before.conversation, "the conversation changed")
        expect(entryId()?.version === install.old, `the integration changed to ${entryId()?.version}`)
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "U5",
    title:
      "a usage limit fails the execution: a Pi subagent whose execution hits a usage limit ends that execution failed with failure kind limit, its creator gets one notice naming the limit, and the same harness process keeps running in its pane with nothing else started",
    run: (w) =>
      usageLimited(
        w,
        { name: "limit", limited: (p) => p.startsWith("/v1/") },
        async ({ id, seen, row, status, pane: paneNow, log }) => {
          const notices = () => {
            const db = readDb(path.join(w.vibestHome, "vibest.db"))

            try {
              return db
                .query<{ content: string }, [string]>(
                  `SELECT content FROM inbox WHERE about_session_id = ? AND sender_type = 'vibest' ORDER BY id`,
                )
                .all(id)
                .map((r) => r.content)
            } finally {
              db.close()
            }
          }

          const kinds = () => {
            const db = readDb(path.join(w.vibestHome, "vibest.db"))

            try {
              return db
                .query<{ kind: string | null }, [string]>(
                  `SELECT failure_kind AS kind FROM execution WHERE session_id = ? ORDER BY id`,
                )
                .all(id)
                .map((r) => r.kind)
            } finally {
              db.close()
            }
          }

          const fail = async (e: Error) => {
            throw new Error(
              `${e.message}; row ${JSON.stringify(row())}; executions ${JSON.stringify(status())}; notices ${JSON.stringify(notices())}; the model saw ${JSON.stringify(seen)}\n${await log()}`,
            )
          }

          await until("the harness reports its pid", () => row().pid !== null, 60_000).catch(fail)
          const pane = paneNow()
          const before = row()
          await until("the limited execution fails", () => status().some((m) => m.status === "failed"), 120_000).catch(
            fail,
          )
          await until("the creator is told", () => notices().length > 0, 30_000).catch(fail)
          await Bun.sleep(5_000)
          expect(kinds().join() === "limit", `one execution, failed with kind limit: ${JSON.stringify(kinds())}`)
          const said = notices()
          expect(said.length === 1 && said[0]!.includes("hit a usage limit"), `notices: ${JSON.stringify(said)}`)
          expect(
            row().pid === before.pid && alive(before.pid!) && row().provider === "first",
            `the harness was replaced: ${JSON.stringify(before)} -> ${JSON.stringify(row())}`,
          )
          expect(paneNow() === pane, `the subagent is in ${paneNow()}, not ${pane}`)
        },
      ),
  },
]

export default checks
