import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"

import { PROTOCOL } from "../../../../packages/protocol/src/protocol.ts"
import type { Check } from "../check.ts"
import { ask, heldModel, piDir } from "../fake-model.ts"
import { expect, herdr, row, SESSIONS, Skip, until, type World } from "../world.ts"
import { dropHerdrSession, project } from "./inbox.ts"

export const piProject = async (w: World, name: string) => {
  for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
  const model = heldModel()
  const session = `${w.herdrSession}-${name}`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  const env = {}
  const repo = await project(w, name)
  const pi = `PI_CODING_AGENT_DIR=${await piDir(w, `pi-${name}`, model.url)}`
  const startDaemon = () => w.ok(["daemon"], { env })
  await w.stopDaemon()
  await startDaemon()
  await w.startMain({
    harness: "pi",
    session,
    cwd: repo,
    env: { PI_CODING_AGENT_DIR: pi.slice("PI_CODING_AGENT_DIR=".length) },
    processEnv: env,
    timeoutMs: 90_000,
  })
  const q = <A>(sql: string, ...args: Array<string | number>) => row<A>(w, sql, ...args)
  const directory = await fs.realpath(repo)
  await until(
    "the main agent's conversation",
    () =>
      q<{ c: string | null }>(
        `SELECT s.harness_session_id AS c FROM ${SESSIONS} s JOIN project p ON p.entry_session_id = s.id
          WHERE p.directory = ?`,
        directory,
      )?.c != null,
    60_000,
  )
  const runSub = async (task: string, ...flags: Array<string>) =>
    (
      JSON.parse(
        await w.okViaEntry(["run", "pi", "--session", session, "--env", pi, ...flags, "--", ask(task)], {
          cwd: repo,
          env,
          timeoutMs: 90_000,
        }),
      ) as { id: string }
    ).id
  const pane = (id: string) => {
    const runtime = q<{ r: string | null }>(`SELECT runtime AS r FROM ${SESSIONS} s WHERE id = ?`, id)?.r
    return ((JSON.parse(runtime ?? "{}") as { id?: string }).id ?? "").split("/")[1] ?? ""
  }
  const pid = (id: string) => q<{ pid: number | null }>(`SELECT pid FROM ${SESSIONS} s WHERE id = ?`, id)?.pid ?? null
  const executionEnds = (id: string) =>
    q<{ n: number }>("SELECT count(*) AS n FROM execution WHERE session_id = ? AND outcome IS NOT NULL", id)?.n ?? 0
  const sent = (id: string) =>
    q<{ n: number }>("SELECT count(*) AS n FROM inbox WHERE sender_session_id = ?", id)?.n ?? 0
  const lastEnd = (id: string) => {
    return q<{ status: string; reply: string | null; failure: string | null }>(
      `SELECT outcome AS status, reply, failure FROM execution WHERE session_id = ? AND outcome IS NOT NULL
        ORDER BY ended_at DESC, id DESC LIMIT 1`,
      id,
    )
  }
  const exited = (id: string) =>
    q<{ n: number }>(`SELECT count(*) AS n FROM ${SESSIONS} s WHERE id = ? AND exited_at IS NOT NULL`, id)?.n === 1
  const sendRow = (id: string, message: string) =>
    q<{ id: number; status: string }>(
      "SELECT id, status FROM inbox WHERE session_id = ? AND kind = 'send' AND content = ? ORDER BY id DESC LIMIT 1",
      id,
      message,
    )
  const notices = (id: string, text: string) =>
    q<{ n: number }>(
      "SELECT count(*) AS n FROM inbox WHERE sender_session_id = ? AND kind = 'notice' AND instr(content, ?) > 0",
      id,
      text,
    )?.n ?? 0
  const idle = (id: string) =>
    q<{ id: number }>("SELECT id FROM execution WHERE session_id = ? AND outcome IS NULL", id) === undefined &&
    executionEnds(id) > 0
  const vibestSend = (id: string, message: string) => w.ok(["send", id, "--", message], { cwd: repo, env })
  const log = () => fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")
  const close = async () => {
    model.stop()
    await dropHerdrSession(w, session)
  }
  return {
    model,
    socket,
    repo,
    env,
    startDaemon,
    runSub,
    vibestSend,
    pane,
    pid,
    sent,
    executionEnds,
    lastEnd,
    exited,
    sendRow,
    notices,
    idle,
    log,
    close,
  }
}

const recordMs = (evidence: string, id: string, what: string, ms: number) =>
  fs.writeFile(path.join(evidence, `${id}-timing.json`), `${JSON.stringify({ [what]: ms })}\n`)

const killedMidExecution = async (
  w: World,
  evidence: string,
  name: string,
  kill: (p: Awaited<ReturnType<typeof piProject>>, id: string) => Promise<void>,
) => {
  const p = await piProject(w, name)
  try {
    const sub = await p.runSub("held")
    await until("the subagent's execution held", () => p.model.held() > 0, 60_000)
    const message = ask("queued")
    await p.vibestSend(sub, message)
    await until("the send queued", () => p.sendRow(sub, message)?.status === "pending", 15_000)
    const t0 = Date.now()
    await kill(p, sub)
    await until(
      "the exit seen",
      () =>
        p.lastEnd(sub)?.status === "failed" &&
        p.lastEnd(sub)?.failure != null &&
        p.sendRow(sub, message)?.status === "failed" &&
        p.notices(sub, "exited during an execution") === 1 &&
        p.notices(sub, "Not delivered") === 1 &&
        p.notices(sub, "") === 1 &&
        p.exited(sub),
      30_000,
    )
    await recordMs(evidence, name.toUpperCase(), "exitSeenMs", Date.now() - t0)
    expect(p.sent(sub) === 1, `${p.sent(sub)} rows sent by the killed session, not its one notice`)
    return { p, sub }
  } catch (e) {
    await p.close()
    throw e
  }
}

const rpc = (socket: string, method: string, params: object, headers: ReadonlyArray<[string, string]>) =>
  new Promise<unknown>((resolve, reject) => {
    let buf = ""
    const sock = net.createConnection(socket, () =>
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: "1", method, params, headers }) + "\n"),
    )
    sock.on("data", (chunk) => {
      buf += chunk.toString()
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      const reply = JSON.parse(buf.slice(0, nl)) as { result?: unknown; error?: unknown }
      sock.destroy()
      if ("error" in reply) reject(new Error(`${method}: ${JSON.stringify(reply.error)}`))
      else resolve(reply.result)
    })
    sock.on("error", reject)
  })

const untaken = (w: World, id: string) =>
  row<{ n: number }>(
    w,
    "SELECT count(*) AS n FROM inbox WHERE session_id = ? AND kind = 'task' AND execution_id IS NULL",
    id,
  )?.n === 1

const nothingMoreComesWithin = (ms: number) => Bun.sleep(ms)

const killWindowTries = 5

const checks: ReadonlyArray<Check> = [
  {
    id: "S21",
    covers: ["S8"],
    title:
      "pane killed mid-execution: the execution is failed (the session exited), the queued message failed, the session exited, and the creator gets one notice carrying the exit and the undelivered message, and nothing else; the time it took is recorded",
    run: async (w, evidence) => {
      const { p } = await killedMidExecution(w, evidence, "s21", async (p, id) => {
        await herdr(p.socket, "pane.close", { pane_id: p.pane(id) })
      })
      await p.close()
    },
  },
  {
    id: "S51",
    title:
      "pane killed while the session is idle: the session exited, its completed execution stays completed, and the creator gets exactly one notice that it exited",
    run: async (w) => {
      const p = await piProject(w, "s51")
      try {
        p.model.release()
        const sub = await p.runSub("idle")
        await until("idle", () => p.idle(sub), 60_000)
        await herdr(p.socket, "pane.close", { pane_id: p.pane(sub) })
        await until("the exit seen", () => p.exited(sub) && p.notices(sub, "exited") === 1, 30_000)
        await nothingMoreComesWithin(2_000)
        expect(
          p.executionEnds(sub) === 1 && p.lastEnd(sub)?.status === "completed" && p.sent(sub) === 1,
          `executions ${p.executionEnds(sub)}, last ${JSON.stringify(p.lastEnd(sub))}, rows sent ${p.sent(sub)}`,
        )
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S22",
    title: "harness killed (kill -9, the pane stays): as S21, and the pane still exists",
    run: async (w, evidence) => {
      let pane = ""
      const { p } = await killedMidExecution(w, evidence, "s22", async (p, id) => {
        const pid = p.pid(id)
        expect(pid !== null, `no pid recorded for ${id}`)
        pane = p.pane(id)
        process.kill(pid!, "SIGKILL")
      })
      try {
        const panes = (await herdr(p.socket, "pane.list", {})).panes as Array<{ pane_id: string }>
        expect(
          panes.some((x) => x.pane_id === pane),
          `pane ${pane} is gone`,
        )
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S23",
    covers: ["S8"],
    title:
      "vibestd restarted mid-execution: (a) restart while held, then release; (b) kill -9 vibestd right after the execution end is logged; both: exactly one completed execution that points at its report and sends nothing",
    run: async (w) => {
      const p = await piProject(w, "s23")
      try {
        const one = async (sub: string, what: string) => {
          await until(
            `${what}: one completed execution`,
            () => p.executionEnds(sub) === 1 && p.lastEnd(sub)?.status === "completed",
            60_000,
          )
          await nothingMoreComesWithin(3_000)
          expect(
            p.executionEnds(sub) === 1 && p.sent(sub) === 0,
            `${what}: ${p.executionEnds(sub)} execution ends, ${p.sent(sub)} rows sent`,
          )
          const end = p.lastEnd(sub)!
          expect(typeof end.reply === "string", `${what}: execution ${JSON.stringify(end)}`)
        }
        const a = await p.runSub("a")
        await until("(a) held", () => p.model.held() > 0, 60_000)
        const restart = await w.tty(["daemon", "restart"], "y\n", { cwd: p.repo, env: p.env, timeoutMs: 60_000 })
        expect(restart.code === 0, `vibest daemon restart exited ${restart.code}: ${restart.stderr}${restart.stdout}`)
        p.model.releaseOne()
        await one(a, "(a)")
        const b = await p.runSub("b")
        await until("(b) held", () => p.model.held() > 0, 60_000)
        const from = (await p.log()).length
        p.model.releaseOne()
        await until(
          "(b) execution end logged",
          async () => (await p.log()).slice(from).includes(`execution end ${b}`),
          30_000,
        )
        const pid = await w.daemonPid()
        await w.killDaemon(pid)
        await p.startDaemon()
        await one(b, "(b)")
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S24",
    title:
      "vibestd killed mid-delivery (kill -9 while the row is delivering): the row ends failed with the may-or-may-not notice, once, is not delivered again, and a later send is delivered",
    run: async (w) => {
      const p = await piProject(w, "s24")
      try {
        p.model.release()
        const sub = await p.runSub("first")
        await until("idle", () => p.idle(sub), 60_000)
        let message = ""
        for (let attempt = 1; message === "" && attempt <= killWindowTries; attempt++) {
          const tried = ask(`cut${attempt}`)
          const daemon = await w.daemonPid()
          const sending = p.vibestSend(sub, tried)
          let status: string | undefined
          for (const deadline = Date.now() + 15_000; ; await Bun.sleep(1)) {
            status = p.sendRow(sub, tried)?.status
            if (status !== "pending" && status !== undefined) break
            expect(Date.now() < deadline, "the row never left pending")
          }
          if (status === "delivering") {
            await w.killDaemon(daemon)
            await sending.catch(() => undefined)
            await p.startDaemon()
            message = tried
          } else {
            await sending
            await until(`idle after ${tried}`, () => p.idle(sub), 60_000)
          }
        }
        expect(message !== "", "every try delivered the row before vibestd could be killed")
        await until(
          "the cut-off row failed with its notice",
          () => p.sendRow(sub, message)?.status === "failed" && p.notices(sub, "may or may not have arrived") === 1,
          20_000,
        )
        await until("idle again", () => p.idle(sub), 60_000)
        expect(p.sendRow(sub, message)?.status === "failed", "the cut-off row moved again")
        expect(p.notices(sub, "may or may not have arrived") === 1, "more than one notice")
        const later = ask("later")
        await p.vibestSend(sub, later)
        await until("the later send delivered", () => p.sendRow(sub, later)?.status === "delivered", 30_000).catch(
          async (e: Error) => {
            const screen = await herdr(p.socket, "pane.read", {
              pane_id: p.pane(sub),
              source: "visible",
              strip_ansi: true,
            })
            throw new Error(
              `${e.message}; its screen:\n${String((screen.read as { text?: string } | undefined)?.text ?? "")}`,
            )
          },
        )
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S25",
    title:
      "herdr hands over to a new server: the reset reconcile runs, a pane closed after it is seen exited (the time it took is recorded), and a send to another idle subagent is delivered",
    run: async (w, evidence) => {
      const p = await piProject(w, "s25")
      try {
        p.model.release()
        const gone = await p.runSub("gone")
        const kept = await p.runSub("kept")
        await until("both idle", () => p.idle(gone) && p.idle(kept), 90_000)
        const from = (await p.log()).length
        await herdr(p.socket, "server.live_handoff", {})
        await until("the reset reconcile", async () => /reconcile herdr\b/.test((await p.log()).slice(from)), 30_000)
        const t0 = Date.now()
        await herdr(p.socket, "pane.close", { pane_id: p.pane(gone) })
        await until("the closed pane exited", () => p.exited(gone), 10_000)
        await recordMs(evidence, "S25", "closeSeenMs", Date.now() - t0)
        const message = ask("after")
        await p.vibestSend(kept, message)
        await until("the send delivered", () => p.sendRow(kept, message)?.status === "delivered", 30_000)
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S28",
    title:
      "vibestd killed (kill -9) while a subagent's start has no terminal yet: the next vibestd ends it launch_failed with one notice; its worktree is removed, or kept with the reason when the harness's tab survived",
    run: async (w) => {
      const p = await piProject(w, "s28")
      try {
        p.model.release()
        const startTerminal = (id: string) =>
          row<{ t: string; ended: number }>(
            w,
            `SELECT coalesce(terminal, '') AS t, ended_at IS NOT NULL AS ended
            FROM process WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
            id,
          )
        let sub = ""
        for (let attempt = 1; sub === "" && attempt <= killWindowTries; attempt++) {
          const daemon = await w.daemonPid()
          const id = await p.runSub(`cut${attempt}`)
          const now = startTerminal(id)
          if (now?.t === "" && now.ended === 0) {
            await w.killDaemon(daemon)
            sub = id
          } else await until(`${id} idle`, () => p.idle(id), 60_000)
        }
        expect(sub !== "", "every try opened its terminal before vibestd could be killed")
        const worktree = row<{ d: string }>(w, "SELECT directory AS d FROM session WHERE id = ?", sub)?.d ?? ""
        expect(worktree !== "", `no worktree recorded for ${sub}`)
        await p.startDaemon()
        await until("the cut-off start's notice", () => p.notices(sub, "never finished starting") === 1, 30_000)
        const end = row<{ reason: string }>(
          w,
          "SELECT end_reason AS reason FROM process WHERE session_id = ? AND end_reason != 'superseded'",
          sub,
        )
        expect(end?.reason === "launch_failed", `its process ended ${end?.reason}`)
        const text =
          row<{ c: string }>(w, "SELECT content AS c FROM inbox WHERE sender_session_id = ? AND kind = 'notice'", sub)
            ?.c ?? ""
        const kept = await fs.stat(worktree).then(
          () => true,
          () => false,
        )
        expect(
          kept ? text.includes("has its working directory in it") : text.includes("its worktree was removed"),
          `worktree ${kept ? "kept" : "removed"}, notice: ${text}`,
        )
        await nothingMoreComesWithin(2_000)
        expect(p.notices(sub, "never finished starting") === 1, "more than one notice")
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S29",
    title:
      "vibestd killed (kill -9) while a subagent's terminal waits for its harness to be ready (no execution open, the task not handed over): the next vibestd types the task once, as its first execution's input, and the one completed execution sends nothing",
    run: async (w) => {
      const p = await piProject(w, "s29")
      try {
        p.model.release()
        let sub = ""
        for (let attempt = 1; sub === "" && attempt <= killWindowTries; attempt++) {
          const daemon = await w.daemonPid()
          const id = await p.runSub(`t${attempt}`)
          const placed = () =>
            row<{ n: number }>(
              w,
              "SELECT count(*) AS n FROM process WHERE session_id = ? AND coalesce(terminal, '') != ''",
              id,
            )?.n === 1
          const executions = () =>
            row<{ n: number }>(w, "SELECT count(*) AS n FROM execution WHERE session_id = ?", id)?.n
          for (const deadline = Date.now() + 60_000; !placed(); await Bun.sleep(1))
            expect(Date.now() < deadline, `${id}: its terminal never opened`)
          await w.killDaemon(daemon)
          if (untaken(w, id) && executions() === 0) sub = id
          await p.startDaemon()
          if (sub === "") await until(`${id} idle`, () => p.idle(id), 60_000)
        }
        expect(sub !== "", "every try handed the task over before vibestd was killed")
        const task = `t${row<{ c: string }>(w, "SELECT content AS c FROM inbox WHERE session_id = ? AND kind = 'task'", sub)?.c.match(/done-t(\d+)/)?.[1]}`
        await until(
          "one completed execution",
          () => p.executionEnds(sub) === 1 && p.lastEnd(sub)?.status === "completed",
          60_000,
        )
        await nothingMoreComesWithin(3_000)
        expect(p.model.asked(task) === 1, `the task was asked ${p.model.asked(task)} times`)
        expect(p.sent(sub) === 0, `${p.sent(sub)} rows sent by the session`)
        const input = row<{ n: number }>(
          w,
          `SELECT count(*) AS n FROM event e JOIN inbox i ON i.session_id = e.aggregate AND i.id = e.data ->> '$.inbox'
            WHERE e.aggregate = ? AND e.type = 'inbox.moved' AND i.kind = 'task' AND e.data ->> '$.execution' IS NOT NULL`,
          sub,
        )?.n
        expect(input === 1, `the task is the input of ${input} executions`)
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S30",
    title:
      "vibest archive cut off after its mark (vibestd killed with the session's ended_at set, its process not ended): the next vibestd closes the tab and ends the process archived, keeping the worktree; vibest archive then removes it",
    run: async (w) => {
      const p = await piProject(w, "s30")
      try {
        p.model.release()
        const marked = (id: string) =>
          row<{ e: number | null }>(w, "SELECT ended_at AS e FROM session WHERE id = ?", id)?.e != null
        const processEnded = (id: string) =>
          row<{ n: number }>(
            w,
            "SELECT count(*) AS n FROM process WHERE session_id = ? AND ended_at IS NOT NULL AND end_reason != 'superseded'",
            id,
          )?.n === 1
        let sub = ""
        let pane = ""
        let worktree = ""
        for (let attempt = 1; sub === "" && attempt <= killWindowTries; attempt++) {
          const id = await p.runSub(`archived${attempt}`)
          await until(`${id} idle`, () => p.idle(id), 90_000)
          const tab = p.pane(id)
          const dir = row<{ d: string }>(w, "SELECT directory AS d FROM session WHERE id = ?", id)?.d ?? ""
          expect(tab !== "" && dir !== "", `no pane or worktree recorded for ${id}`)
          const daemon = await w.daemonPid()
          const archiving = w.vibest(["archive", id], { cwd: p.repo, env: p.env, timeoutMs: 60_000 })
          for (const deadline = Date.now() + 60_000; !marked(id); await Bun.sleep(1))
            expect(Date.now() < deadline, `${id}: vibest archive never set its mark`)
          await w.killDaemon(daemon)
          await archiving
          if (!processEnded(id)) [sub, pane, worktree] = [id, tab, dir]
          await p.startDaemon()
        }
        expect(sub !== "", "every try finished the archive before vibestd was killed")
        const ended = () =>
          row<{ reason: string }>(
            w,
            "SELECT end_reason AS reason FROM process WHERE session_id = ? AND end_reason != 'superseded'",
            sub,
          )?.reason
        await until("its process ended", () => ended() !== undefined, 30_000)
        expect(ended() === "archived", `its process ended ${ended()}`)
        const panes = (await herdr(p.socket, "pane.list", {})).panes as Array<{ pane_id: string }>
        expect(!panes.some((x) => x.pane_id === pane), `pane ${pane} is still open`)
        const exists = () =>
          fs.stat(worktree).then(
            () => true,
            () => false,
          )
        expect(await exists(), `the worktree ${worktree} was removed`)
        expect(p.notices(sub, "") === 0, "a notice for a clean finish")
        await w.ok(["archive", sub], { cwd: p.repo, env: p.env, timeoutMs: 60_000 })
        expect(!(await exists()), `vibest archive kept the worktree ${worktree}`)
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S32",
    title:
      "Send repeated over vibest.sock with one request id (as vibest send retries a lost answer): the same answer, one row, one delivery, the task asked once and two executions",
    run: async (w) => {
      const p = await piProject(w, "s32")
      try {
        p.model.release()
        const sub = await p.runSub("first")
        await until("idle", () => p.idle(sub), 60_000)
        const message = ask("again")
        const send = () =>
          rpc(path.join(w.vibestHome, "vibest.sock"), "Send", { id: sub, message, request: "e2e-request-1" }, [
            ["vibest-protocol", String(PROTOCOL)],
            ["vibest-caller", "cli"],
            ["vibest-repository", p.repo],
          ])
        const first = await send()
        const second = await send()
        expect(
          JSON.stringify(first) === JSON.stringify(second) && JSON.stringify(first).includes(sub),
          `answers ${JSON.stringify(first)} and ${JSON.stringify(second)}`,
        )
        await until("delivered", () => p.sendRow(sub, message)?.status === "delivered", 30_000)
        await until("its second execution", () => p.executionEnds(sub) === 2 && p.idle(sub), 60_000)
        await nothingMoreComesWithin(2_000)
        const rows = row<{ n: number }>(
          w,
          "SELECT count(*) AS n FROM inbox WHERE session_id = ? AND kind = 'send'",
          sub,
        )?.n
        expect(rows === 1, `${rows} send rows`)
        expect(p.model.asked("again") === 1, `the message was asked ${p.model.asked("again")} times`)
        expect(
          p.executionEnds(sub) === 2 && p.sent(sub) === 0,
          `${p.executionEnds(sub)} execution ends, ${p.sent(sub)} rows sent`,
        )
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S27",
    title:
      "archive with a process working in the worktree: the worktree is kept and the reason names the process; the time archive took is recorded",
    run: async (w, evidence) => {
      const p = await piProject(w, "s27")
      let processOutsideThePane: ReturnType<typeof Bun.spawn> | undefined
      try {
        p.model.release()
        const sub = await p.runSub("archive")
        await until("the subagent idle", () => p.idle(sub), 90_000)
        const worktree = row<{ d: string }>(w, "SELECT directory AS d FROM session WHERE id = ?", sub)?.d ?? ""
        expect(worktree !== "", `no worktree recorded for ${sub}`)
        processOutsideThePane = Bun.spawn(["sleep", "600"], { cwd: worktree, stdio: ["ignore", "ignore", "ignore"] })
        const t0 = Date.now()
        const out = await w.vibest(["archive", sub], { cwd: p.repo, env: p.env, timeoutMs: 60_000 })
        await recordMs(evidence, "S27", "archiveMs", Date.now() - t0)
        const said = `${out.stdout}${out.stderr}`
        expect(
          said.includes(String(processOutsideThePane.pid)),
          `archive does not name process ${processOutsideThePane.pid}: ${said}`,
        )
        expect(
          await fs.stat(worktree).then(
            () => true,
            () => false,
          ),
          `the worktree ${worktree} was removed while process ${processOutsideThePane.pid} used it`,
        )
        const send = await w.vibest(["send", sub, "--", "more"], { cwd: p.repo, env: p.env })
        expect(
          send.code !== 0 && `${send.stdout}${send.stderr}`.includes("archived"),
          `send after archive: ${send.stdout}${send.stderr}`,
        )
      } finally {
        processOutsideThePane?.kill()
        await p.close()
      }
    },
  },
]

export default checks
