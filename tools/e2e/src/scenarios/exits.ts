// What vibestd learns with no poll (feature-map S21 to S29): an exit the runtime pushes, a stop of vibestd itself in the
// middle of a turn or of a delivery, and a herdr server that hands over to a new one. Pi subagents and a Pi main agent
// on the fake model of inbox.ts; vibestd, herdr and Pi are the real ones.
import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { alive, expect, herdr, row, SESSIONS, Skip, until, type World } from "../world.ts"
import { dropHerdrSession, heldModel, piDir, project } from "./inbox.ts"

const ask = (task: string) =>
  `Do not run any tool. Reply with exactly two lines: the first is "done-${task}", the second is "status: completed".`

/** A Pi main agent in a herdr session of its own, for project `name`, its subagents on the held fake model. */
const piProject = async (w: World, name: string) => {
  for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
  const model = heldModel()
  const session = `${w.herdrSession}-${name}`
  const socket = path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")
  // vibestd and so the herdr server start with an empty ZDOTDIR: the pane shell keeps this build first on PATH.
  const zdot = path.join(w.root, `zdotdir-${name}`)
  await fs.mkdir(zdot, { recursive: true })
  const env = { ZDOTDIR: zdot }
  const repo = await project(w, name)
  const pi = `PI_CODING_AGENT_DIR=${await piDir(w, `pi-${name}`, model.url)}`
  const startDaemon = () => w.ok(["daemon"], { env })
  await w.stopDaemon()
  await startDaemon()
  await w.ok(["--harness", "pi", "--session", session, "--headless", "--env", pi], {
    cwd: repo,
    env,
    timeoutMs: 90_000,
  })
  const q = <A>(sql: string, ...args: Array<string | number>) => row<A>(w, sql, ...args)
  const runSub = async (task: string) =>
    (
      JSON.parse(
        await w.ok(["run", "pi", "--session", session, "--env", pi, "--", ask(task)], {
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
  const turnEnds = (id: string) =>
    q<{ n: number }>("SELECT count(*) AS n FROM event WHERE session_id = ? AND type = 'turn.end'", id)?.n ?? 0
  const results = (id: string) =>
    q<{ n: number }>("SELECT count(*) AS n FROM inbox WHERE sender_session_id = ? AND kind = 'result'", id)?.n ?? 0
  const lastEnd = (id: string) => {
    const end = q<{ data: string }>(
      "SELECT data FROM event WHERE session_id = ? AND type = 'turn.end' ORDER BY id DESC LIMIT 1",
      id,
    )
    return end === undefined
      ? undefined
      : (JSON.parse(end.data) as { status?: string; report?: number; output?: string })
  }
  const exited = (id: string) =>
    q<{ n: number }>(`SELECT count(*) AS n FROM ${SESSIONS} s WHERE id = ? AND exited_at IS NOT NULL`, id)?.n === 1
  const sendRow = (id: string, message: string) =>
    q<{ id: number; status: string }>(
      "SELECT id, status FROM inbox WHERE recipient_session_id = ? AND kind = 'send' AND content = ? ORDER BY id DESC LIMIT 1",
      id,
      message,
    )
  const notices = (id: string, text: string) =>
    q<{ n: number }>(
      "SELECT count(*) AS n FROM inbox WHERE sender_session_id = ? AND kind = 'notice' AND instr(content, ?) > 0",
      id,
      text,
    )?.n ?? 0
  /** Idle between turns: its turns all ended. */
  const idle = (id: string) =>
    q<{ id: number }>(
      `SELECT t.id AS id FROM event t WHERE t.session_id = ? AND t.type = 'turn.start'
        AND NOT EXISTS (SELECT 1 FROM event e WHERE e.turn_id = t.id AND e.type = 'turn.end')`,
      id,
    ) === undefined && turnEnds(id) > 0
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
    results,
    lastEnd,
    exited,
    sendRow,
    notices,
    idle,
    log,
    close,
  }
}

/** A queued send, then `kill` ends the held subagent: within 2 s its turn fails, the send fails with its notice, and it exited. */
const killedMidTurn = async (
  w: World,
  name: string,
  kill: (p: Awaited<ReturnType<typeof piProject>>, id: string) => Promise<void>,
) => {
  const p = await piProject(w, name)
  try {
    const sub = await p.runSub("held")
    await until("the subagent's turn held", () => p.model.held() > 0, 60_000)
    const message = ask("queued")
    await p.vibestSend(sub, message)
    await until("the send queued", () => p.sendRow(sub, message)?.status === "pending", 15_000)
    const t0 = Date.now()
    await kill(p, sub)
    await until(
      "the exit seen",
      () =>
        p.lastEnd(sub)?.status === "failed" &&
        p.sendRow(sub, message)?.status === "failed" &&
        p.notices(sub, "exited before it was delivered") === 1 &&
        p.exited(sub),
      10_000,
    )
    const ms = Date.now() - t0
    expect(ms <= 2_000, `the exit took ${ms} ms to be seen (at most 2000)`)
    expect(p.results(sub) === 1, `${p.results(sub)} results for one turn`)
    return { p, sub }
  } catch (e) {
    await p.close()
    throw e
  }
}

/** Session `id`'s task was never handed over: no `inbox.status` for it. */
const untaken = (w: World, id: string) =>
  row<{ n: number }>(
    w,
    `SELECT count(*) AS n FROM inbox i WHERE i.recipient_session_id = ? AND i.kind = 'task'
      AND NOT EXISTS (SELECT 1 FROM event e WHERE e.inbox_id = i.id AND e.type = 'inbox.status')`,
    id,
  )?.n === 1

const checks: ReadonlyArray<Check> = [
  {
    id: "S21",
    title:
      "pane killed mid-turn: within 2 s the turn is failed (the session exited), the queued message failed with its notice, and the session exited; one result",
    run: async (w) => {
      const { p } = await killedMidTurn(w, "s21", async (p, id) => {
        await herdr(p.socket, "pane.close", { pane_id: p.pane(id) })
      })
      await p.close()
    },
  },
  {
    id: "S22",
    title: "harness killed (kill -9, the pane stays): as S21 within 2 s, and the pane still exists",
    run: async (w) => {
      let pane = ""
      const { p } = await killedMidTurn(w, "s22", async (p, id) => {
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
    title:
      "vibestd restarted mid-turn: (a) restart while held, then release; (b) kill -9 vibestd right after the turn end is logged; both: exactly one completed result whose turn.end points at its report",
    run: async (w) => {
      const p = await piProject(w, "s23")
      try {
        const one = async (sub: string, what: string) => {
          await until(
            `${what}: one completed result`,
            () => p.results(sub) === 1 && p.lastEnd(sub)?.status === "completed",
            60_000,
          )
          // Nothing more comes for it.
          await Bun.sleep(3_000)
          expect(p.results(sub) === 1, `${what}: ${p.results(sub)} results`)
          const end = p.lastEnd(sub)!
          expect(typeof end.report === "number" && end.output === undefined, `${what}: turn.end ${JSON.stringify(end)}`)
        }
        // (a)
        const a = await p.runSub("a")
        await until("(a) held", () => p.model.held() > 0, 60_000)
        const restart = await w.tty(["daemon", "restart"], "y\n", { cwd: p.repo, env: p.env, timeoutMs: 60_000 })
        expect(restart.code === 0, `vibest daemon restart exited ${restart.code}: ${restart.stderr}${restart.stdout}`)
        p.model.releaseOne()
        await one(a, "(a)")
        // (b)
        const b = await p.runSub("b")
        await until("(b) held", () => p.model.held() > 0, 60_000)
        const from = (await p.log()).length
        p.model.releaseOne()
        await until("(b) turn end logged", async () => (await p.log()).slice(from).includes(`turn end ${b}`), 30_000)
        const pid = await w.daemonPid()
        expect(pid !== undefined, "no vibestd pid")
        process.kill(pid!, "SIGKILL")
        await until("vibestd gone", () => !alive(pid!), 10_000)
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
        const message = ask("cut")
        const sending = p.vibestSend(sub, message)
        // The row is `delivering` from its claim until the session is seen to start the turn: kill vibestd in that window.
        const daemon = await w.daemonPid()
        expect(daemon !== undefined, "no vibestd pid")
        for (const deadline = Date.now() + 15_000; ; await Bun.sleep(1)) {
          const status = p.sendRow(sub, message)?.status
          if (status === "delivering") break
          expect(status === "pending" || status === undefined, `the row went ${status} before vibestd could be killed`)
          expect(Date.now() < deadline, "the row never went delivering")
        }
        process.kill(daemon!, "SIGKILL")
        await sending
        await until("vibestd gone", () => !alive(daemon!), 10_000)
        await p.startDaemon()
        await until(
          "the cut-off row failed with its notice",
          () => p.sendRow(sub, message)?.status === "failed" && p.notices(sub, "may or may not have arrived") === 1,
          20_000,
        )
        // Whether or not the text reached Pi before the kill, it is not handed over a second time.
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
      "herdr hands over to a new server: the reset reconcile runs, a pane closed after it is seen exited within 2 s, and a send to another idle subagent is delivered",
    run: async (w) => {
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
        const ms = Date.now() - t0
        expect(ms <= 2_000, `the close took ${ms} ms to be seen (at most 2000)`)
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
        const daemon = await w.daemonPid()
        expect(daemon !== undefined, "no vibestd pid")
        const sub = await p.runSub("cut")
        // `vibest run` answers once the row is stored; the start then makes the worktree and opens the terminal.
        const startTerminal = () =>
          row<{ t: string; ended: number }>(
            w,
            `SELECT json_extract(e.data, '$.terminal') AS t,
              EXISTS (SELECT 1 FROM event x WHERE x.process_id = e.id AND x.type = 'process.end') AS ended
            FROM event e WHERE e.session_id = ? AND e.type = 'process.start' ORDER BY e.id DESC LIMIT 1`,
            sub,
          )
        const now = startTerminal()
        expect(now?.t === "" && now.ended === 0, `the start already has a terminal: ${JSON.stringify(now)}`)
        process.kill(daemon!, "SIGKILL")
        await until("vibestd gone", () => !alive(daemon!), 10_000)
        const worktree = row<{ d: string }>(w, "SELECT directory AS d FROM session WHERE id = ?", sub)?.d ?? ""
        expect(worktree !== "", `no worktree recorded for ${sub}`)
        await p.startDaemon()
        await until("the cut-off start's notice", () => p.notices(sub, "never finished starting") === 1, 30_000)
        const end = row<{ reason: string }>(
          w,
          "SELECT json_extract(data, '$.reason') AS reason FROM event WHERE session_id = ? AND type = 'process.end'",
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
        // Nothing more comes for it.
        await Bun.sleep(2_000)
        expect(p.notices(sub, "never finished starting") === 1, "more than one notice")
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S29",
    title:
      "vibestd killed (kill -9) while a subagent's first turn waits for its harness to be ready (the task not handed over): the next vibestd types the task once, as that turn's input, and one completed result reaches the main agent",
    run: async (w) => {
      const p = await piProject(w, "s29")
      try {
        p.model.release()
        // The window is the first look for the harness's ready report: a try that misses it (the task linked before
        // the kill) is not this case, so the next subagent tries again.
        let sub = ""
        for (let attempt = 1; sub === "" && attempt <= 5; attempt++) {
          const daemon = await w.daemonPid()
          expect(daemon !== undefined, "no vibestd pid")
          const id = await p.runSub(`t${attempt}`)
          const opened = () =>
            row<{ n: number }>(w, "SELECT count(*) AS n FROM event WHERE session_id = ? AND type = 'turn.start'", id)
              ?.n === 1
          for (const deadline = Date.now() + 60_000; !opened(); await Bun.sleep(1))
            expect(Date.now() < deadline, `${id}: its first turn never opened`)
          process.kill(daemon!, "SIGKILL")
          await until("vibestd gone", () => !alive(daemon!), 10_000)
          if (untaken(w, id)) sub = id
          await p.startDaemon()
          if (sub === "") await until(`${id} idle`, () => p.idle(id), 60_000)
        }
        expect(sub !== "", "every try handed the task over before vibestd was killed")
        const task = `t${row<{ c: string }>(w, "SELECT content AS c FROM inbox WHERE recipient_session_id = ? AND kind = 'task'", sub)?.c.match(/done-t(\d+)/)?.[1]}`
        await until(
          "one completed result",
          () => p.results(sub) === 1 && p.lastEnd(sub)?.status === "completed",
          60_000,
        )
        await until(
          "the result delivered to the main agent",
          () =>
            row<{ s: string }>(w, "SELECT status AS s FROM inbox WHERE sender_session_id = ? AND kind = 'result'", sub)
              ?.s === "delivered",
          30_000,
        )
        // Nothing more comes for it.
        await Bun.sleep(3_000)
        expect(p.model.asked(task) === 1, `the task was asked ${p.model.asked(task)} times`)
        expect(p.results(sub) === 1, `${p.results(sub)} results`)
        const input = row<{ n: number }>(
          w,
          `SELECT count(*) AS n FROM event e JOIN inbox i ON i.id = e.inbox_id
            WHERE e.session_id = ? AND e.type = 'inbox.status' AND i.kind = 'task' AND e.turn_id IS NOT NULL`,
          sub,
        )?.n
        expect(input === 1, `the task is the input of ${input} turns`)
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S27",
    title:
      "archive with a process working in the worktree: one look, within 3 s; the worktree is kept and the reason names the process",
    run: async (w) => {
      const p = await piProject(w, "s27")
      let holder: ReturnType<typeof Bun.spawn> | undefined
      try {
        p.model.release()
        const sub = await p.runSub("archive")
        await until("the subagent idle", () => p.idle(sub), 90_000)
        const worktree = row<{ d: string }>(w, "SELECT directory AS d FROM session WHERE id = ?", sub)?.d ?? ""
        expect(worktree !== "", `no worktree recorded for ${sub}`)
        // A process outside the pane with its working directory in the worktree: closing the pane does not end it.
        holder = Bun.spawn(["sleep", "600"], { cwd: worktree, stdio: ["ignore", "ignore", "ignore"] })
        const t0 = Date.now()
        const out = await w.vibest(["archive", sub], { cwd: p.repo, env: p.env, timeoutMs: 60_000 })
        const ms = Date.now() - t0
        const said = `${out.stdout}${out.stderr}`
        expect(ms <= 3_000, `archive took ${ms} ms (at most 3000): ${said}`)
        expect(said.includes(String(holder.pid)), `archive does not name process ${holder.pid}: ${said}`)
        expect(
          await fs.stat(worktree).then(
            () => true,
            () => false,
          ),
          `the worktree ${worktree} was removed while process ${holder.pid} used it`,
        )
        // Archived all the same: it takes no more messages.
        const send = await w.vibest(["send", sub, "--", "more"], { cwd: p.repo, env: p.env })
        expect(
          send.code !== 0 && `${send.stdout}${send.stderr}`.includes("archived"),
          `send after archive: ${send.stdout}${send.stderr}`,
        )
      } finally {
        holder?.kill()
        await p.close()
      }
    },
  },
]

export default checks
