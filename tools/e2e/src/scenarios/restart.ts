import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { answerFolderTrust, typeAndEnter } from "../drivers/claude.ts"
import {
  ask,
  claudeEnv,
  fakeAnthropic,
  holdsSlowResultModel,
  lastUser,
  piDir,
  text,
  usageLimitedModel,
} from "../fake-model.ts"
import {
  agentName,
  alive,
  binary,
  compiled,
  expect,
  expectFacts,
  fail,
  harnesses,
  herdr,
  readDb,
  row,
  rows,
  SESSIONS,
  Skip,
  TURNS,
  until,
  type World,
} from "../world.ts"
import { piShadow } from "../world/shadow.ts"
import { dropHerdrSession, project } from "./inbox.ts"

type Row = { id: string; harness_session_id: string | null; pid: number | null; version: string | null }
type Agent = { name?: string | null; pane_id: string; agent?: string | null }

const OLD = "0.0.0-old"

const ensureRuntime = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (args.includes("--runtime")) return args
  if (args[0] === "run") return ["run", "--runtime", "herdr", ...args.slice(1)]
  if (args.length === 0 || (args[0]!.startsWith("-") && args[0] !== "--version" && args[0] !== "--help"))
    return ["--runtime", "herdr", ...args]
  return args
}

const oldInstall = async (w: World, name: string) => {
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
  await patch(
    path.join(old, "harnesses", "pi", "extension.mjs"),
    /var VERSION = package_default\.version;/,
    `var VERSION = "${OLD}";`,
  )
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

const usageLimitMove = async (
  w: World,
  o: { readonly name: string; readonly limited: (path: string) => boolean; readonly plugin: string },
  body: (m: {
    readonly id: string
    readonly seen: ReadonlyArray<string>
    readonly row: () => { harness: string; provider: string | null; pid: number | null; conversation: string | null }
    readonly status: () => ReadonlyArray<{ status: string }>
    readonly listed: () => Promise<Agent | undefined>
    readonly log: () => Promise<string>
  }) => Promise<void>,
) => {
  for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
  const model = usageLimitedModel(o.limited)
  const session = `${w.herdrSession}-${o.name}`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  const plugin = path.join(w.vibestHome, "plugins", `${o.name}.ts`)
  try {
    const repo = await project(w, o.name)
    const base = `http://127.0.0.1:${model.port}`
    const agentDir = await piShadow(
      path.join(w.root, `pi-${o.name}`),
      w.profile,
      { first: { baseUrl: `${base}/v1` }, second: { baseUrl: `${base}/v2` } },
      undefined,
    )
    await fs.mkdir(path.dirname(plugin), { recursive: true })
    await fs.writeFile(plugin, o.plugin)
    const env = { PI_CODING_AGENT_DIR: agentDir }
    await w.stopDaemon()
    await w.ok(["daemon"], { cwd: repo, env })
    await until(
      "the move plugin is active",
      async () =>
        (await w.json<Array<{ id: string; status: string }>>(["plugins"], { cwd: repo, env })).some(
          (p) => p.id === "move-e2e" && p.status === "active",
        ),
      30_000,
    )
    const id = (
      JSON.parse(
        await w.ok(["run", "pi", "--provider", "first", "--model", "m", "--session", session, ask("limit")], {
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
      status: () => read<{ status: string }>(`SELECT status FROM ${TURNS} t WHERE session_id = ? ORDER BY id`),
      listed: async () =>
        ((await herdr(socket, "agent.list", {}).catch(() => ({ agents: [] }))).agents as Array<Agent>).find(
          (a) => a.name === agentName(id),
        ),
      log: async () => (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")).slice(-4000),
    })
  } finally {
    model.stop()
    await fs.rm(plugin, { force: true })
    await w.stopDaemon()
    await dropHerdrSession(w, session)
  }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "U2",
    covers: ["D8"],
    title:
      "vibest update: vibestd hands over; No keeps an old Pi main agent mid-turn (its old protocol is told to run vibest update), Yes restarts its Pi subagent (herdr lists it as s-<id> before and after) and then it in its pane on the same session and conversation, its inbox continues the turn, and messages still arrive",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "python3"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = holdsSlowResultModel()
      const session = `${w.herdrSession}-restart`
      try {
        const repo = await project(w, "restart")
        const agentDir = await piDir(w, "pi-restart", model.url)
        const { old, wrapper, point, env } = await oldInstall(w, "restart")
        const piEnv = `PI_CODING_AGENT_DIR=${agentDir}`
        const vibest = (args: ReadonlyArray<string>, timeoutMs = 60_000) =>
          w.run(repo, [wrapper, ...ensureRuntime(args)], { env, timeoutMs })
        const ok = async (args: ReadonlyArray<string>, timeoutMs?: number) => {
          const r = await vibest(args, timeoutMs)
          expect(r.code === 0, `vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
          return r.stdout
        }
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
        const main = () =>
          read(`s.agent_type = 'main' AND s.ended_at IS NULL AND s.directory LIKE ?`, `%/${path.basename(repo)}`)
        const subRow = (id: string) => read("s.id = ?", id)
        const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
        const listed = async (id: string) =>
          ((await herdr(socket, "agent.list", {})).agents as Array<Agent>).find((a) => a.name === agentName(id))
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
          m.at(-1)!.includes("<agent-") && m.at(-1)!.includes(marker)

        await w.stopDaemon()
        await w.startMain({
          harness: "pi",
          session,
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: agentDir },
          processEnv: env,
          bin: wrapper,
          timeoutMs: 60_000,
        })
        const zero = (
          JSON.parse(await ok(["run", "pi", "--session", session, "--env", piEnv, ask("zero")])) as { id: string }
        ).id
        await reached("the main agent's turn on the first message", result("done-zero"))
        await until("herdr lists the subagent as s-<id>", async () => (await listed(zero))?.agent === "pi", 60_000)
        const subPane = (await listed(zero))!.pane_id
        const subBefore = subRow(zero)!
        expect(subBefore.version === old && subBefore.pid !== null, `the subagent's row: ${JSON.stringify(subBefore)}`)
        await until(
          "the main agent reports the old integration and its conversation",
          () => {
            const row = main()
            return row?.version === old && row.harness_session_id !== null && row.pid !== null
          },
          60_000,
        )
        const before = main()!
        const daemonBefore = await w.daemonPid()
        const address = async () =>
          (
            await w
              .json<{ sessions: Array<{ id: string; address: unknown }> }>(["ls"], { cwd: repo, env })
              .then((l) => l.sessions)
          ).find((e) => e.id === before.id)?.address
        const addressBefore = await address()
        await ok(["run", "pi", "--session", session, "--env", piEnv, ask("slow")])
        await until("the main agent's held turn", () => model.held() > 0, 120_000)

        await point(binary)
        const update = async (answer: string) => {
          const pty = ["python3", "-I", path.join(import.meta.dirname, "..", "terminal.py"), wrapper, "update"]
          const r = await w.run(repo, pty, { env, stdin: `${answer}\n`, timeoutMs: 180_000 })
          const out = r.stdout.replace(/\r/g, "")
          expect(r.code === 0, `vibest update (${answer}) exited ${r.code}: ${out}${r.stderr}`)
          return out
        }
        const no = await update("n")
        expect(/vibestd: handoff\./.test(no), `vibestd was not handed over: ${no}`)
        expect(no.includes("They keep the old integration"), `No did not keep the agent: ${no}`)
        const daemonAfter = await w.daemonPid()
        expect(daemonAfter !== undefined && daemonAfter !== daemonBefore, `vibestd ${daemonBefore} -> ${daemonAfter}`)
        expect(daemonBefore === undefined || !alive(daemonBefore), `the old vibestd ${daemonBefore} still runs`)
        const kept = main()
        expect(kept?.pid === before.pid && alive(before.pid!), `No restarted the main agent: ${JSON.stringify(kept)}`)
        expect(kept?.version === old, `the kept agent's integration: ${kept?.version}`)
        const refused = await fetch("http://vibestd/inbox/poll", {
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
          yes.includes("vibest update has finished") &&
            yes.includes(before.id.slice(0, 8)) &&
            yes.includes(zero.slice(0, 8)),
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
        await until(
          "herdr lists the restarted subagent as s-<id>",
          async () => (await listed(zero))?.agent === "pi",
          60_000,
        )
        expect((await listed(zero))?.pane_id === subPane, `the subagent's pane changed: ${subPane}`)
        let after = null as ReturnType<typeof main>
        await until(
          "the main agent restarted on this integration",
          () => {
            after = main()
            return after?.pid != null && after.pid !== before.pid && after.version !== old && after.version !== null
          },
          120_000,
        )
        expect(after?.id === before.id, `the main agent's session changed: ${before.id} -> ${after?.id}`)
        expect(
          after?.harness_session_id === before.harness_session_id,
          `the conversation changed: ${before.harness_session_id} -> ${after?.harness_session_id}`,
        )
        expect(after?.pid !== before.pid, `the harness pid did not change (${before.pid})`)
        expect(!alive(before.pid!), `the old harness ${before.pid} still runs`)
        await until("the restarted main agent reports this integration", () => main()?.version !== old, 30_000)
        expect(
          JSON.stringify(await address()) === JSON.stringify(addressBefore),
          `the main agent's terminal changed: ${JSON.stringify(addressBefore)} -> ${JSON.stringify(await address())}`,
        )
        await reached(
          "the continue notice of the interrupted turn, with the earlier turns",
          (m) =>
            /^user: .*"text":"vibest update is done and restarted this agent; do not run it again, continue the interrupted work\./.test(
              m.at(-1)!,
            ) &&
            m.some((x) => x.includes("done-zero")) &&
            m.some((x) => x.includes("done-slow")),
        )
        await ok(["run", "pi", "--session", session, "--env", piEnv, ask("after")])
        await reached("the main agent's turn on a message after the update", result("done-after"))
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
        const notice = () =>
          row<{ status: string }>(
            w,
            "SELECT status FROM inbox WHERE recipient_session_id = ? AND kind = 'notice'",
            before.id,
          )?.status
        await until("the continue notice delivered", () => notice() === "delivered").catch(() =>
          fail(`the main agent's continue notice: ${notice()}`),
        )
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
      "vibest daemon restart onto another vibest: Yes to both questions replaces vibestd and restarts an old Pi subagent in place, in the same pane on the same conversation",
    run: async (w) => {
      for (const bin of ["pi", "herdr", "python3"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = holdsSlowResultModel()
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
        const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
        const listed = async (id: string) =>
          ((await herdr(socket, "agent.list", {})).agents as Array<Agent>).find((a) => a.name === agentName(id))

        await w.stopDaemon()
        await ok(["daemon"])
        const id = (
          JSON.parse(
            await ok(["run", "pi", "--session", session, "--env", `PI_CODING_AGENT_DIR=${agentDir}`, ask("one")]),
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
        const pane = (await listed(id))?.pane_id
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
            out.includes("vibest daemon restart has finished") &&
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
        await until(
          "herdr lists the restarted subagent as s-<id>",
          async () => (await listed(id))?.agent === "pi",
          60_000,
        )
        expect((await listed(id))?.pane_id === pane, `the subagent's pane changed: ${pane}`)
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
      "vibest update run by a Claude main agent itself (fake model): the CLI hands the restart to vibestd and returns; vibestd restarts it in its pane on the same conversation, its inbox gets the continue notice and that turn ends with a reply, and vibest update runs once",
    run: async (w) => {
      for (const bin of ["herdr", "claude"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const session = `${w.herdrSession}-cupdate`
      const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
      const UPDATE = "Run vibest update --yes now."
      const NOTICE =
        "vibest update is done and restarted this agent; do not run it again, continue the interrupted work."
      let updates = 0
      let noticed = false
      let wrapper = "vibest"
      const model = fakeAnthropic((r) => {
        const last = text(lastUser(r))
        if (last.includes(UPDATE)) {
          if (r.tools.length > 0) updates++
          return { tool: "Bash", input: { command: `${wrapper} update --yes` } }
        }
        if (last.includes(NOTICE)) {
          noticed = true
          return "CONTINUED"
        }
        return last.includes('"tool_result"') ? "UPDATED" : "ok"
      })
      try {
        const repo = await project(w, "claude-update")
        const install = await oldInstall(w, "cupdate")
        wrapper = install.wrapper
        const configTheResumeCheckReads = w.config.claude
        const flags = await claudeEnv(w, "cupdate", model.url, configTheResumeCheckReads)
        const vibest = async (args: ReadonlyArray<string>, timeoutMs = 120_000) => {
          const r = await w.run(repo, [install.wrapper, ...ensureRuntime(args)], { env: install.env, timeoutMs })
          expect(r.code === 0, `vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
          return r.stdout
        }
        type Main = {
          id: string
          conversation: string | null
          runtime: string
          pid: number | null
          version: string | null
        }
        const main = () => {
          const db = readDb(path.join(w.vibestHome, "vibest.db"))
          try {
            return (
              db
                .query<Main, [string]>(
                  `SELECT id, harness_session_id AS conversation, runtime, pid, version
                   FROM ${SESSIONS} s WHERE agent_type = 'main' AND ended_at IS NULL AND directory = ?`,
                )
                .get(repo) ?? undefined
            )
          } finally {
            db.close()
          }
        }
        const pane = () => ((JSON.parse(main()?.runtime ?? "{}") as { id?: string }).id ?? "").split("/")[1] ?? ""
        const screen = async () => {
          const r = await herdr(socket, "pane.read", { pane_id: pane(), source: "visible", strip_ansi: true })
          return String((r.read as { text?: string } | undefined)?.text ?? "")
        }
        const log = async () =>
          (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")).slice(-4000)
        const failWith = async (e: Error) => {
          throw new Error(`${e.message}; row ${JSON.stringify(main())}; screen:\n${await screen()}\n${await log()}`)
        }

        await w.stopDaemon()
        await vibest(["daemon"])
        await w.startMain({
          harness: "claude",
          session,
          cwd: repo,
          env: flags,
          processEnv: install.env,
          bin: install.wrapper,
          timeoutMs: 120_000,
        })
        await until("the main agent's row", () => pane() !== "", 60_000)
        await answerFolderTrust(screen, (key) => herdr(socket, "pane.send_keys", { pane_id: pane(), keys: [key] }))
        await until(
          "the main agent polls on the old integration",
          () => main()?.version === install.old && main()?.conversation != null && main()?.pid != null,
          120_000,
        ).catch(failWith)
        const before = main()!

        await install.point(binary)
        await typeAndEnter(
          screen,
          {
            text: (text) => herdr(socket, "pane.send_text", { pane_id: pane(), text }),
            enter: () => herdr(socket, "pane.send_keys", { pane_id: pane(), keys: ["enter"] }),
          },
          UPDATE,
        )

        await until(
          "the main agent restarted on this integration",
          () => {
            const row = main()
            return (
              row !== undefined &&
              row.pid != null &&
              row.pid !== before.pid &&
              row.version !== install.old &&
              row.version !== null
            )
          },
          240_000,
        ).catch(failWith)
        expect(!alive(before.pid!), `the old Claude ${before.pid} still runs`)
        expect(main()?.id === before.id, `the main agent's session changed: ${before.id} -> ${main()?.id}`)
        expect(
          main()?.conversation === before.conversation,
          `the conversation changed: ${before.conversation} -> ${main()?.conversation}`,
        )
        expect(main()?.runtime === before.runtime, `the terminal changed: ${before.runtime} -> ${main()?.runtime}`)
        const asked = () => model.requests.findIndex((r) => text(lastUser(r)).includes(UPDATE))
        await until(
          "the continue notice in a request after the update",
          () => model.requests.slice(asked() + 1).some((r) => text(lastUser(r)).includes(NOTICE)),
          180_000,
        ).catch(failWith)
        await until(
          "the turn on the continue notice ended with its reply",
          async () => noticed && /[⏺●] CONTINUED\s+\S.*· done/.test(await screen()),
          120_000,
        ).catch(failWith)
        expect(updates === 1, `vibest update was asked for ${updates} times`)
        expect(main()?.pid !== null && alive(main()!.pid!), "the restarted main agent is not running")
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "U5",
    title:
      "a usage-limit move in place: a Pi subagent whose turn hits a usage limit ends only its harness; the next login runs in the same pane (herdr lists it as s-<id> there) and finishes the round",
    run: (w) =>
      usageLimitMove(
        w,
        {
          name: "move",
          limited: (p) => p.startsWith("/v1/"),
          plugin: `import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
export default Plugin.define({
  id: "move-e2e",
  effect: (ctx) => ctx.agent.hook("fail", (e) => Effect.sync(() => { e.move = { harness: "pi", provider: "second", model: "m" } })),
})
`,
        },
        async ({ id, seen, row, status, listed, log }) => {
          await until("herdr lists the subagent as s-<id>", async () => (await listed())?.agent === "pi", 60_000)
          const pane = (await listed())!.pane_id
          await until("the first login's harness reports its pid", () => row().pid !== null, 60_000)
          const before = row()
          await until(
            "the move to the second login",
            () => row().provider === "second" && row().pid !== null && row().pid !== before.pid,
            120_000,
          ).catch(async (e: Error) => {
            throw new Error(
              `${e.message}; row ${JSON.stringify(row())}; the model saw ${JSON.stringify(seen)}\n${await log()}`,
            )
          })
          expect(!alive(before.pid!), `the limited harness ${before.pid} still runs`)
          expect(alive(row().pid!), `the moved harness ${row().pid} does not run`)
          expect(row().harness === "pi", `moved to ${row().harness}`)
          await until(
            "the round completes on the second login",
            () => status().some((m) => m.status === "completed"),
            120_000,
          ).catch(async (e: Error) => {
            throw new Error(
              `${e.message}; rounds ${JSON.stringify(status())}; the model saw ${JSON.stringify(seen)}\n${await log()}`,
            )
          })
          expect(status().length === 1, `one round: ${JSON.stringify(status())}`)
          expect(
            seen.some((s) => s.startsWith("/v2/")),
            `the second login got no request: ${JSON.stringify(seen)}`,
          )
          const after = await listed()
          expect(
            after?.agent === "pi" && after.pane_id === pane,
            `herdr lists ${agentName(id)} at ${after?.pane_id}, not ${pane}`,
          )
        },
      ),
  },
  {
    id: "U8",
    title:
      "a usage-limit move tries each login at most once per round: both Pi logins answer a usage limit while their usage rows read free; the round fails once with no harness left and no third start",
    run: (w) =>
      usageLimitMove(
        w,
        {
          name: "move-twice",
          limited: () => true,
          plugin: `import { Plugin } from "@vibest/plugin"
import { Effect, Schedule } from "effect"
const free = [{ window: "5h", percent: 0, status: "available", resetTime: null }]
export default Plugin.define({
  id: "move-e2e",
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Effect.repeat(
          Effect.all([
            ctx.subscription.report({ harness: "pi", provider: "first", limits: free }),
            ctx.subscription.report({ harness: "pi", provider: "second", limits: free }),
          ]),
          Schedule.spaced("1 second"),
        ),
      )
      yield* ctx.agent.hook("fail", (e) =>
        Effect.sync(() => {
          e.move = { harness: "pi", provider: e.provider === "first" ? "second" : "first", model: "m" }
        }),
      )
    }),
})
`,
        },
        async ({ id, seen, row, status, log }) => {
          const notices = () => {
            const db = readDb(path.join(w.vibestHome, "vibest.db"))
            try {
              return db
                .query<{ content: string }, [string]>(
                  `SELECT content FROM inbox WHERE sender_session_id = ? AND kind = 'notice' ORDER BY id`,
                )
                .all(id)
                .map((r) => r.content)
            } finally {
              db.close()
            }
          }
          const fail = async (e: Error) => {
            throw new Error(
              `${e.message}; row ${JSON.stringify(row())}; rounds ${JSON.stringify(status())}; notices ${JSON.stringify(notices())}; the model saw ${JSON.stringify(seen)}\n${await log()}`,
            )
          }
          await until("the move to the second login", () => row().provider === "second", 120_000).catch(fail)
          await until("the round fails", () => status().some((m) => m.status === "failed"), 120_000).catch(fail)
          const moved = row()
          await until("the round's no-harness-left notice", () =>
            notices().some((r) => r.includes("no harness left")),
          ).catch(fail)
          expect(status().length === 1, `one round: ${JSON.stringify(status())}`)
          expect(status()[0]!.status === "failed", `the round: ${JSON.stringify(status())}`)
          const said = notices()
          expect(said.length === 1 && said[0]!.includes("no harness left"), `notices: ${JSON.stringify(said)}`)
          expect(
            row().provider === "second" && row().pid === moved.pid,
            `a third start: ${JSON.stringify(moved)} -> ${JSON.stringify(row())}`,
          )
          const firstAgain = seen.findIndex((s) => s.startsWith("/v2/"))
          expect(
            firstAgain !== -1 && !seen.slice(firstAgain).some((s) => s.startsWith("/v1/")),
            `the first login got a request after the move: ${JSON.stringify(seen)}`,
          )
        },
      ),
  },
]

export default checks
