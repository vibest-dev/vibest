import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, heldModel } from "../fake-model.ts"
import { alive, expect, expectAnswered, expectFacts, row, until, type World } from "../world.ts"
import { piShadow } from "../world/shadow.ts"
import { piProject } from "./exits.ts"

type Listed = {
  id: string
  title: string
  agent: string
  harness: string
  provider: string | null
  model: string | null
  status: string
  exitedAt: number | null
  address: { id: string }
  worktree: string
  latest: { status: string; summary: string } | null
}
type Removed = {
  processes: string
  pane: string
  worktree: string
  path: string
  branch: string | null
  reasons: Array<string>
}
type Project = Awaited<ReturnType<typeof piProject>>

const ls = async (w: World, p: Project, all = false) =>
  (await w.json<{ sessions: Array<Listed> }>(all ? ["ls", "--all"] : ["ls"], { cwd: p.repo, env: p.env })).sessions

const resultOf = (w: World, p: Project, id: string) =>
  w.json<{
    id: string
    status: string
    answer: { turn: number; status: string; text: string | null } | null
  }>(["result", id], {
    cwd: p.repo,
    env: p.env,
  })

const answered = async (w: World, p: Project, id: string, task: string) =>
  until(
    `the answer of ${task}`,
    async () => ((await resultOf(w, p, id)).answer?.text ?? "").includes(`done-${task}`),
    90_000,
  )

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  )

const git = async (w: World, cwd: string, ...args: Array<string>) => {
  const r = await w.run(cwd, ["git", ...args])
  expect(r.code === 0, `git ${args.join(" ")} in ${cwd}: ${r.stderr}`)
  return r.stdout.trim()
}

const archive = async (w: World, p: Project, id: string, ...flags: Array<string>) =>
  JSON.parse(await w.ok(["archive", id, ...flags], { cwd: p.repo, env: p.env, timeoutMs: 60_000 })) as Removed

const checks: ReadonlyArray<Check> = [
  {
    id: "S1",
    title:
      "vibest run pi --title --provider --model --env --session starts a Pi subagent in a new detached worktree of the repository at its HEAD, in that herdr session, on that provider and model, the --env value not stored; --peer runs a second one in the same worktree",
    run: async (w) => {
      const p = await piProject(w, "s1")
      const second = heldModel()
      try {
        p.model.release()
        second.release()
        const session = `${w.herdrSession}-s1`
        const subDir = await piShadow(path.join(w.root, "pi-s1-sub"), w.profile, {
          fake: { baseUrl: p.model.url },
          second: { baseUrl: second.url, models: ["m2"] },
        })
        const env = `PI_CODING_AGENT_DIR=${subDir}`
        const run = async (task: string, ...flags: Array<string>) =>
          (
            JSON.parse(
              await w.ok(["run", "pi", "--session", session, "--env", env, ...flags, "--", ask(task)], {
                cwd: p.repo,
                env: p.env,
                timeoutMs: 90_000,
              }),
            ) as { id: string }
          ).id
        const a = await run("s1", "--title", "s1 title", "--provider", "second", "--model", "m2")
        await answered(w, p, a, "s1")
        expect(second.asked("s1") > 0 && p.model.asked("s1") === 0, "the turn did not run on provider second")
        const entry = (await ls(w, p)).find((e) => e.id === a)
        expect(
          entry !== undefined &&
            entry.title === "s1 title" &&
            entry.harness === "pi" &&
            entry.provider === "second" &&
            entry.model === "m2" &&
            entry.address.id.split("/")[0] === session,
          `ls: ${JSON.stringify(entry)}`,
        )
        const worktree = await fs.realpath(entry!.worktree)
        expect(worktree !== p.repo && !worktree.startsWith(`${p.repo}/`), `worktree ${worktree}`)
        expect(
          (await git(w, p.repo, "worktree", "list", "--porcelain")).includes(`worktree ${worktree}`),
          `${worktree} is not a worktree of ${p.repo}`,
        )
        expect(
          (await git(w, worktree, "rev-parse", "HEAD")) === (await git(w, p.repo, "rev-parse", "HEAD")),
          "the worktree is not at the repository's HEAD",
        )
        const branch = await w.run(worktree, ["git", "symbolic-ref", "-q", "HEAD"])
        expect(branch.code !== 0, `the worktree is on ${branch.stdout.trim()}, not detached`)
        for (const file of ["vibest.db", "vibest.db-wal"]) {
          const bytes = await fs.readFile(path.join(w.vibestHome, file), "latin1").catch(() => "")
          expect(!bytes.includes(subDir), `${file} stores the --env value`)
        }
        const b = await run("s1peer", "--peer", a.slice(0, 8))
        await answered(w, p, b, "s1peer")
        const peer = (await ls(w, p)).find((e) => e.id === b)
        expect(
          peer !== undefined &&
            (await fs.realpath(peer.worktree)) === worktree &&
            peer.address.id !== entry!.address.id,
          `peer: ${JSON.stringify(peer)}, first: ${JSON.stringify(entry)}`,
        )
      } finally {
        second.stop()
        await p.close()
      }
    },
  },
  {
    id: "S5",
    title:
      "vibest result has no answer before a subagent's first turn ends and then holds its reply; vibest status names the running vibestd; vibest ls lists the main agent and the subagent with its latest reply; after archive only vibest ls --all lists it, exited",
    run: async (w) => {
      const p = await piProject(w, "s5")
      try {
        const a = await p.runSub("s5")
        await until("the subagent's turn at the model", () => p.model.held() > 0, 60_000)
        const before = await resultOf(w, p, a)
        expect(before.id === a && before.answer === null, `result before the turn ended: ${JSON.stringify(before)}`)
        p.model.release()
        await answered(w, p, a, "s5")
        const after = await resultOf(w, p, a)
        const projected = row<{ answer: string | null; reported: string | null }>(
          w,
          `SELECT t.answer, e.data ->> '$.reply' AS reported FROM turn t
            JOIN event e ON e.type = 'turn.ended' AND e.data ->> '$.turn' = t.id
            WHERE t.session_id = ? AND t.status = 'completed'`,
          a,
        )
        expect(
          projected?.answer?.includes("done-s5") === true &&
            projected.answer === projected.reported &&
            after.answer?.text === projected.answer &&
            after.answer.status === "completed",
          `turn.answer: ${JSON.stringify(projected)}, vibest result: ${JSON.stringify(after.answer)}`,
        )
        const status = await w.json<{ daemon: { status: string; pid: number | null } }>(["status"], {
          cwd: p.repo,
          env: p.env,
        })
        expect(
          status.daemon.status === "running" && status.daemon.pid === (await w.daemonPid()),
          `status: ${JSON.stringify(status)}`,
        )
        await until("the subagent idle", () => p.idle(a), 30_000)
        const listed = await ls(w, p)
        const sub = listed.find((e) => e.id === a)
        expect(
          listed.some((e) => e.agent === "main") &&
            sub !== undefined &&
            sub.latest?.summary.includes("done-s5") === true,
          `ls: ${JSON.stringify(listed)}`,
        )
        await archive(w, p, a)
        expect(!(await ls(w, p)).some((e) => e.id === a), "ls still lists the archived subagent")
        const gone = (await ls(w, p, true)).find((e) => e.id === a)
        expect(gone !== undefined && gone.exitedAt !== null, `ls --all: ${JSON.stringify(gone)}`)
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S52",
    title: "vibest report is a usage error: sessions message with vibest send",
    run: async (w) => {
      const r = await w.vibest(["report", "--", "x"])
      expect(r.code !== 0 && /report/.test(r.stderr), `vibest report exited ${r.code}: ${r.stderr}${r.stdout}`)
    },
  },
  {
    id: "S6",
    title:
      "a just-finished --archive-on-idle session loses its worktree, with no notice and nothing it sent still waiting; vibest run --archive-on-completion is a usage error; vibest archive of a clean subagent closes its pane, its harness process exits and removes the worktree; uncommitted changes or commits on no branch keep it with the reason; a commit on a branch is kept in that branch and the worktree removed; --keep-worktree keeps a clean one",
    run: async (w) => {
      const p = await piProject(w, "s6")
      try {
        p.model.release()
        const auto = await p.runSub("auto", "--archive-on-idle")
        let autoTree = ""
        await until(
          "the session's worktree path",
          async () => {
            autoTree = (await ls(w, p, true)).find((e) => e.id === auto)?.worktree ?? ""
            return autoTree !== ""
          },
          30_000,
        )
        await answered(w, p, auto, "auto")
        await until(
          "the just-finished session is archived and its worktree is gone",
          async () => p.exited(auto) && !(await exists(autoTree)),
          45_000,
        )
        expect(p.notices(auto, "working directory") === 0, "its own exiting processes kept the worktree")
        expect(p.notices(auto, "") === 0, "a notice for a clean archive")
        const waiting = row<{ n: number }>(
          w,
          "SELECT count(*) AS n FROM inbox WHERE (sender_session_id = ?1 OR recipient_session_id = ?1) AND status IN ('pending', 'delivering')",
          auto,
        )
        expect(waiting?.n === 0, `rows still waiting for the archived session: ${waiting?.n}`)
        const ended = (type: string) =>
          row<{ n: number }>(
            w,
            "SELECT count(*) AS n FROM event WHERE session_id = ? AND type = ? AND data ->> '$.reason' = 'archived'",
            auto,
            type,
          )?.n
        expect(
          ended("session.ended") === 1 && ended("process.ended") === 1,
          `archived events: session ${ended("session.ended")}, process ${ended("process.ended")}`,
        )
        const old = await w.vibest(["run", "pi", "--archive-on-completion", "--", "x"], { cwd: p.repo, env: p.env })
        expect(old.code !== 0, "--archive-on-completion was accepted")
        const ready = async (task: string) => {
          const id = await p.runSub(task)
          await answered(w, p, id, task)
          await until(`${task} idle`, () => p.idle(id), 30_000)
          return { id, worktree: (await ls(w, p)).find((e) => e.id === id)!.worktree }
        }
        const clean = await ready("clean")
        const pid = p.pid(clean.id)
        expect(pid !== null && alive(pid), `no live harness pid for ${clean.id}`)
        const out = await archive(w, p, clean.id)
        expect(
          out.processes === "exited" && out.pane === "closed" && out.worktree === "removed",
          `clean: ${JSON.stringify(out)}`,
        )
        expect(!alive(pid!) && !(await exists(clean.worktree)), "clean: the harness or the worktree is still there")

        const dirty = await ready("dirty")
        await fs.writeFile(path.join(dirty.worktree, "notes.txt"), "mine\n")
        const kept = await archive(w, p, dirty.id)
        expect(
          kept.pane === "closed" &&
            kept.worktree === "kept" &&
            kept.reasons.includes("worktree kept: uncommitted changes") &&
            (await fs.readFile(path.join(dirty.worktree, "notes.txt"), "utf8")) === "mine\n",
          `dirty: ${JSON.stringify(kept)}`,
        )

        const loose = await ready("loose")
        await git(w, loose.worktree, "commit", "-q", "--allow-empty", "-m", "loose")
        const looseOut = await archive(w, p, loose.id)
        expect(
          looseOut.worktree === "kept" && looseOut.reasons.includes("worktree kept: commits not on any branch"),
          `commits on no branch: ${JSON.stringify(looseOut)}`,
        )

        const branched = await ready("branched")
        await git(w, branched.worktree, "switch", "-q", "-c", "s6/branched")
        await git(w, branched.worktree, "commit", "-q", "--allow-empty", "-m", "branched")
        const commit = await git(w, branched.worktree, "rev-parse", "HEAD")
        const branchedOut = await archive(w, p, branched.id)
        expect(
          branchedOut.worktree === "removed" && branchedOut.branch === "s6/branched",
          `a branch: ${JSON.stringify(branchedOut)}`,
        )
        expect((await git(w, p.repo, "rev-parse", "s6/branched")) === commit, "the branch lost its commit")

        const asked = await ready("asked")
        const askedOut = await archive(w, p, asked.id, "--keep-worktree")
        expect(
          askedOut.pane === "closed" &&
            askedOut.worktree === "kept" &&
            askedOut.reasons.includes("worktree kept as asked (--keep-worktree)") &&
            (await exists(asked.worktree)),
          `--keep-worktree: ${JSON.stringify(askedOut)}`,
        )
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S9",
    title:
      "with VIBEST_MAX_SESSIONS=2 in vibestd, the main agent is not counted: two subagents start, the third vibest run fails LimitReached naming the limit, and starts once one is archived",
    run: async (w) => {
      const p = await piProject(w, "s9")
      try {
        p.model.release()
        Object.assign(p.env, { VIBEST_MAX_SESSIONS: "2" })
        await w.stopDaemon()
        await p.startDaemon()
        const first = await p.runSub("one")
        await p.runSub("two")
        const third = await w.vibest(
          [
            "run",
            "pi",
            "--session",
            `${w.herdrSession}-s9`,
            "--env",
            `PI_CODING_AGENT_DIR=${w.root}/pi-s9`,
            "--",
            ask("three"),
          ],
          { cwd: p.repo, env: p.env, timeoutMs: 90_000 },
        )
        const said = `${third.stdout}${third.stderr}`
        expect(
          third.code !== 0 && said.includes("LimitReached") && said.includes("VIBEST_MAX_SESSIONS=2"),
          `third run exited ${third.code}: ${said}`,
        )
        await archive(w, p, first)
        expectFacts(w, first, ["session.created", "session.ended", "process.ended"])
        const archived = row<{ ended: number | null; reason: string | null }>(
          w,
          "SELECT s.ended_at AS ended, p.end_reason AS reason FROM session s JOIN process p ON p.session_id = s.id WHERE s.id = ?",
          first,
        )
        expect(
          archived?.ended != null && archived.reason === "archived",
          `the archived session: ${JSON.stringify(archived)}`,
        )
        const three = await p.runSub("three")
        await answered(w, p, three, "three")
        await expectAnswered(w, three)
      } finally {
        await p.close()
      }
    },
  },
]

export default checks
