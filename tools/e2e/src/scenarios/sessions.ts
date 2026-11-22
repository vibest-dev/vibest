import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import {
  ask,
  entryRunMessage,
  heldModel,
  nextEntryRun,
  piDir,
  reply,
  sseHeaders,
  text,
  toolCall,
  type Message,
} from "../fake-model.ts"
import { alive, expect, row, until, type World } from "../world.ts"
import { piShadow } from "../world/shadow.ts"
import { piProject } from "./exits.ts"
import { dropHerdrSession } from "./inbox.ts"
import sessionStop from "./session-stop.ts"

type ListedGit = {
  branch: string
  pushed: boolean
  saved: boolean
  why: string
  unknown?: string
}

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
  git: ListedGit | null
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
    reply: { execution: number; status: string; text: string | null } | null
  }>(["result", id], {
    cwd: p.repo,
    env: p.env,
  })

const answered = async (w: World, p: Project, id: string, task: string) =>
  until(
    `the reply of ${task}`,
    async () => ((await resultOf(w, p, id)).reply?.text ?? "").includes(`done-${task}`),
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

const spawningModel = (child: string, flags: string) => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      const system = text(messages.find((m) => m.role === "system" || m.role === "developer"))
      const vibest = /run `([^`]+) send [0-9a-f-]{36} -- '<message>'`/.exec(system)?.[1]
      const last = messages.at(-1)

      const answer =
        vibest !== undefined && last?.role === "user" && text(last).includes("spawn-child")
          ? toolCall("call-run", "bash", { command: `${vibest} run pi ${flags} -- '${ask(child)}'` })
          : reply(text(last).includes(`done-${child}`) ? `done-${child}\nstatus: completed` : "ok")

      return new Response(answer, { headers: sseHeaders })
    },
  })

  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const fileReadingModel = () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      const last = messages.at(-1)
      const attached = /Attached files: ([^\s\\"]+)/.exec(text(last))?.[1]
      const word = /s57-word-(\w+)/.exec(text(last))?.[1]

      const answer =
        last?.role === "user" && attached !== undefined
          ? toolCall("call-read", "bash", { command: `cat ${attached}` })
          : last?.role === "tool" && word !== undefined
            ? reply(`done-s57 ${word}\nstatus: completed`)
            : reply("ok")

      return new Response(answer, { headers: sseHeaders })
    },
  })

  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const filesPlugin = (out: string) => `import fs from "node:fs"
import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"
export default Plugin.define({
  id: "see-files",
  effect: (ctx) =>
    ctx.agent.hook("start.before", (event) =>
      Effect.sync(() => fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ prompt: event.prompt, files: event.files, contents: event.files.map((file) => fs.readFileSync(file, "utf8")) }) + "\\n")),
    ),
})
`

const checks: ReadonlyArray<Check> = [
  {
    id: "S1",
    title:
      "vibest run pi --title --provider --model --env --session starts a Pi subagent in a new detached worktree of the repository at its HEAD, in that herdr session, on that provider and model, the --env value not stored; --share runs a second one in the same worktree",
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
              await w.okViaEntry(["run", "pi", "--session", session, "--env", env, ...flags, "--", ask(task)], {
                cwd: p.repo,
                env: p.env,
                timeoutMs: 90_000,
              }),
            ) as { id: string }
          ).id

        const a = await run("s1", "--title", "s1 title", "--provider", "second", "--model", "m2")
        await answered(w, p, a, "s1")
        expect(second.asked("s1") > 0 && p.model.asked("s1") === 0, "the execution did not run on provider second")
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

        const b = await run("s1share", "--share", a.slice(0, 8))
        await answered(w, p, b, "s1share")
        const sharer = (await ls(w, p)).find((e) => e.id === b)
        expect(
          sharer !== undefined &&
            (await fs.realpath(sharer.worktree)) === worktree &&
            sharer.address.id !== entry!.address.id,
          `sharer: ${JSON.stringify(sharer)}, first: ${JSON.stringify(entry)}`,
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
      "vibest result has no reply before a subagent's first execution ends and then holds its reply; vibest status names the running vibestd; vibest ls lists the entry session and the subagent with its latest reply; a worktree removed from outside leaves every session listed, that row's git unknown and the other complete; after archive only vibest ls --all lists it, exited",
    run: async (w) => {
      const p = await piProject(w, "s5")

      try {
        const a = await p.runSub("s5")
        await until("the subagent's execution at the model", () => p.model.held() > 0, 60_000)
        const before = await resultOf(w, p, a)
        expect(before.id === a && before.reply === null, `result before the execution ended: ${JSON.stringify(before)}`)
        p.model.release()
        await answered(w, p, a, "s5")
        const after = await resultOf(w, p, a)

        const projected = row<{ reply: string | null; reported: string | null }>(
          w,
          `SELECT t.reply, e.data ->> '$.reply' AS reported FROM execution t
            JOIN event e ON e.aggregate = t.session_id AND e.type = 'execution.succeeded' AND e.data ->> '$.executionId' = t.id
            WHERE t.session_id = ? AND t.outcome = 'completed'`,
          a,
        )

        expect(
          projected?.reply?.includes("done-s5") === true &&
            projected.reply === projected.reported &&
            after.reply?.text === projected.reply &&
            after.reply.status === "completed",
          `execution.reply: ${JSON.stringify(projected)}, vibest result: ${JSON.stringify(after.reply)}`,
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
          listed.some((e) => e.agent === "coordinator") &&
            sub !== undefined &&
            sub.latest?.summary.includes("done-s5") === true,
          `ls: ${JSON.stringify(listed)}`,
        )
        const keptId = await p.runSub("s5kept")
        await answered(w, p, keptId, "s5kept")
        const keptBefore = (await ls(w, p)).find((e) => e.id === keptId)
        expect(
          sub !== undefined &&
            sub.worktree !== "" &&
            keptBefore?.worktree !== undefined &&
            sub.worktree !== keptBefore.worktree,
          `worktrees: ${sub?.worktree} ${keptBefore?.worktree}`,
        )
        await fs.rm(sub!.worktree, { recursive: true, force: true })
        const afterGone = await ls(w, p)
        const marked = afterGone.find((e) => e.id === a)
        const kept = afterGone.find((e) => e.id === keptId)
        expect(
          afterGone.some((e) => e.agent === "coordinator") &&
            marked?.git?.unknown === "git cannot read it" &&
            kept?.git?.saved === true &&
            kept.git.unknown === undefined &&
            kept.latest?.summary.includes("done-s5kept") === true,
          `ls after the worktree was removed: ${JSON.stringify(afterGone)}`,
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
    id: "S6",
    title:
      "vibest archive of a clean subagent closes its pane, its harness process exits and removes the worktree; uncommitted changes or commits on no branch keep it with the reason; a commit on a branch is kept in that branch and the worktree removed; --keep-worktree keeps a clean one; archiving a --share session while the first one lives finishes it with the shared worktree kept, and the reconcile after vibestd restarts posts no notice for it",
    run: async (w) => {
      const p = await piProject(w, "s6")

      try {
        p.model.release()

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

        const implementer = await ready("implementer")
        const reviewer = await p.runSub("reviewer", "--share", implementer.id.slice(0, 8))
        await answered(w, p, reviewer, "reviewer")
        await until("reviewer idle", () => p.idle(reviewer), 30_000)
        const sharedOut = await archive(w, p, reviewer)
        expect(
          sharedOut.pane === "closed" &&
            sharedOut.processes === "exited" &&
            sharedOut.worktree === "kept" &&
            sharedOut.reasons.includes(`worktree kept: session ${implementer.id} still works in it`) &&
            p.exited(reviewer),
          `--share: ${JSON.stringify(sharedOut)}`,
        )
        const from = (await p.log()).length
        await w.stopDaemon()
        await p.startDaemon()
        await until(
          "the reconcile after the restart",
          async () => /reconcile all: \d+ live sessions/.test((await p.log()).slice(from)),
          30_000,
        )
        expect(p.notices(reviewer, "") === 0, "a notice for the archived --share session")
        expect(
          (await ls(w, p)).some((e) => e.id === implementer.id) && (await exists(implementer.worktree)),
          "the implementer or its worktree is gone",
        )
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S9",
    title:
      "with concurrency [{ max: 2 }] in vibest.json and the entry session running, two subagents given tasks in one entry execution: both vibest run calls return at once, the first starts and the second waits to start with no terminal (vibest ls shows waitingToStart with its harness and runtime) even after the first has replied, and starts once the first is archived; doctor reports the limit and a filtered rule as not supported",
    run: async (w) => {
      const p = await piProject(w, "s9")
      const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

      const subagent = (task: string) =>
        [
          '"$VIBEST_CLI"',
          "run",
          "pi",
          "--session",
          `${w.herdrSession}-s9`,
          "--env",
          `PI_CODING_AGENT_DIR=${w.root}/pi-s9`,
          "--",
          ask(task),
        ]
          .map((word, i) => (i === 0 ? word : quote(word)))
          .join(" ")

      try {
        await fs.writeFile(
          path.join(w.vibestHome, "vibest.json"),
          JSON.stringify({ concurrency: [{ max: 2 }, { agent: "general", max: 5 }] }),
        )
        let doctor = ""
        await until(
          "vibest doctor to report the limit",
          async () =>
            (doctor = (await w.vibest(["doctor"], { cwd: p.repo, env: p.env })).stdout).includes(
              "at most 2 live harness processes on this machine",
            ),
          30_000,
        )
        expect(doctor.includes("rules with harness or agent are not supported yet"), `doctor: ${doctor}`)

        const entry = await w.entryOf(p.repo)
        const run = nextEntryRun()
        const out = path.join(w.root, `entry-run-${run}`)
        const both = `${subagent("one")} && ${subagent("two")}`
        const command = `{ ${both}; } > ${quote(out)} 2>&1; echo $? > ${quote(`${out}.tmp`)} && mv ${quote(`${out}.tmp`)} ${quote(`${out}.exit`)}`
        await w.ok(["send", entry!, "--", entryRunMessage(run, command)], { cwd: p.repo, env: p.env })
        await until("the entry session to run both subagents", () => exists(`${out}.exit`), 180_000)
        const started = await fs.readFile(out, "utf8")
        expect((await fs.readFile(`${out}.exit`, "utf8")).trim() === "0", `the runs: ${started}`)
        const [one, two] = [...started.matchAll(/"id":\s*"([0-9a-f-]{36})"/g)].map((m) => m[1]!)
        expect(one !== undefined && two !== undefined, `two runs: ${started}`)

        const listed = async () => (await ls(w, p)) as Array<Listed & { waitingToStart?: true; runtime: string }>
        const rowOf = async (id: string) => (await listed()).find((r) => r.id === id)
        await until("the first subagent to work", () => p.model.asked("one") === 1, 90_000)
        await until(
          "the second subagent to wait to start",
          async () => (await rowOf(two!))?.waitingToStart === true,
          30_000,
        )
        const waiting = (await rowOf(two!))!
        expect(waiting.address.id === "", `the waiting subagent already has a terminal: ${JSON.stringify(waiting)}`)
        expect(
          waiting.harness === "pi" && waiting.runtime !== "",
          `the waiting subagent does not show its launch choice: ${JSON.stringify(waiting)}`,
        )
        expect((await rowOf(one!))?.waitingToStart === undefined, "the running subagent is listed as waiting")

        p.model.releaseOne()
        await answered(w, p, one!, "one")
        await Bun.sleep(3_000)
        expect((await rowOf(two!))?.waitingToStart === true, "the second subagent started while the first still ran")
        expect(p.model.asked("two") === 0, "the second subagent's task reached the model while the first still ran")

        await w.ok(["archive", one!], { cwd: p.repo, env: p.env, timeoutMs: 60_000 })
        await until("the second subagent to work", () => p.model.asked("two") === 1, 90_000)
        expect((await rowOf(two!))?.waitingToStart === undefined, "the second subagent is still listed as waiting")
        p.model.release()
        await answered(w, p, two!, "two")
      } finally {
        await p.close()
      }
    },
  },
  {
    id: "S41",
    title:
      "vibest run in a plain terminal is refused and leaves no worktree or pane; a session the entry session started runs vibest run and the session it starts records it as its creator",
    run: async (w) => {
      const p = await piProject(w, "s41")
      const subDir = path.join(w.root, "pi-s41-sub")
      const spawning = spawningModel("s41c", `--env PI_CODING_AGENT_DIR=${subDir}`)

      try {
        p.model.release()
        await piShadow(subDir, w.profile, { fake: { baseUrl: spawning.url } })
        const before = await git(w, p.repo, "worktree", "list", "--porcelain")
        const listed = (await ls(w, p)).length
        const refused = await w.vibest(["run", "pi", "--", ask("s41x")], { cwd: p.repo, env: p.env })
        const said = `${refused.stdout}${refused.stderr}`
        expect(
          refused.code !== 0 && said.includes("NoCallingSession") && said.includes("run vibest in a terminal"),
          `a plain-terminal run exited ${refused.code}: ${said}`,
        )
        expect(
          (await git(w, p.repo, "worktree", "list", "--porcelain")) === before && (await ls(w, p)).length === listed,
          "the refused run left a worktree or a session",
        )

        const a = (
          JSON.parse(
            await w.okViaEntry(
              [
                "run",
                "pi",
                "--session",
                `${w.herdrSession}-s41`,
                "--env",
                `PI_CODING_AGENT_DIR=${subDir}`,
                "--",
                ask("spawn-child"),
              ],
              { cwd: p.repo, env: p.env, timeoutMs: 90_000 },
            ),
          ) as { id: string }
        ).id

        const entry = await w.entryOf(p.repo)
        await until(
          "the session the first session started",
          () => row(w, "SELECT id FROM session WHERE parent_session_id = ?", a) !== undefined,
          90_000,
        )
        expect(
          row<{ parent: string }>(w, "SELECT parent_session_id AS parent FROM session WHERE id = ?", a)?.parent ===
            entry,
          `the first session's creator is not the entry session ${entry}`,
        )
      } finally {
        spawning.stop()
        await p.close()
      }
    },
  },
  {
    id: "S57",
    title:
      "vibest run --file copies the file into the session's files folder in the project folder and ends the task with a line naming the copy; a plugin sees that path in agent.start.before files and reads the copy during the hook; the Pi subagent reads the copy and answers with a word from it; archive removes the session's folder",
    run: async (w) => {
      const p = await piProject(w, "s57")
      const model = fileReadingModel()

      try {
        p.model.release()
        const subDir = await piShadow(path.join(w.root, "pi-s57-sub"), w.profile, { fake: { baseUrl: model.url } })
        const seenFile = path.join(w.root, "s57-start-before.jsonl")
        const pluginFile = path.join(w.vibestHome, "plugins", "see-files.ts")
        await fs.mkdir(path.dirname(pluginFile), { recursive: true })
        await fs.writeFile(pluginFile, filesPlugin(seenFile))
        await until("the see-files plugin active", async () =>
          (await w.json<Array<{ id: string; status: string }>>(["plugins"])).some(
            (plugin) => plugin.id === "see-files" && plugin.status === "active",
          ),
        )
        const notes = path.join(w.root, "s57-notes.md")
        await fs.writeFile(notes, "the answer is s57-word-hazel\n")

        const id = (
          JSON.parse(
            await w.okViaEntry(
              [
                "run",
                "pi",
                "--session",
                `${w.herdrSession}-s57`,
                "--env",
                `PI_CODING_AGENT_DIR=${subDir}`,
                "--file",
                notes,
                "--",
                "Read the attached file and answer with its word.",
              ],
              { cwd: p.repo, env: p.env, timeoutMs: 90_000 },
            ),
          ) as { id: string }
        ).id

        const seen = (await fs.readFile(seenFile, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { prompt: string; files: Array<string>; contents: Array<string> })
          .find((event) => event.files.length > 0)

        const copy = seen?.files[0] ?? ""
        const folder = path.dirname(path.dirname(copy))
        expect(
          seen !== undefined &&
            seen.files.length === 1 &&
            seen.contents[0] === "the answer is s57-word-hazel\n" &&
            path.basename(copy) === "s57-notes.md" &&
            folder.endsWith(`/sessions/${id}`) &&
            path.dirname(path.dirname(path.dirname(folder))).endsWith("/projects") &&
            seen.prompt === `Read the attached file and answer with its word.\n\nAttached files: ${copy}` &&
            !seen.prompt.includes("s57-word-hazel"),
          `agent.start.before saw ${JSON.stringify(seen)} for ${id}`,
        )
        expect((await fs.readFile(copy, "utf8")) === "the answer is s57-word-hazel\n", `${copy} is not the copy`)
        await until(
          "the subagent's answer from the attached file",
          async () => ((await resultOf(w, p, id)).reply?.text ?? "").includes("done-s57 hazel"),
          90_000,
        )
        expect(await exists(folder), `${folder} is gone while the session runs`)
        await archive(w, p, id)
        expect(!(await exists(folder)), `${folder} is still there after archive`)
      } finally {
        await fs.rm(path.join(w.vibestHome, "plugins", "see-files.ts"), { force: true })
        model.stop()
        await p.close()
      }
    },
  },
  {
    id: "S58",
    title:
      "vibest worktree list shows each worktree vibest made, grouped by project: a live session's worktree with that session live, an archived session's dirty worktree with the changed-file count and that session archived, a clean worktree kept with --keep-worktree, commits on no branch as unsaved, and each repository of a project of several repositories",
    run: async (w) => {
      const p = await piProject(w, "s58")
      const multi = `${w.herdrSession}-s58m`

      type Repo = { folder: string; branch?: string; commit?: string; state: string; changed?: number }

      type Tree = {
        path: string
        repositories: Array<Repo>
        sessions: Array<{ id: string; title: string; state: string }>
      }

      type Listed = { projects: Array<{ id: string; directory: string; worktrees: Array<Tree> }> }

      const same = async (directory: string, repo: string) =>
        (await fs.realpath(directory)) === (await fs.realpath(repo))

      const find = (listed: Listed, id: string) => {
        for (const project of listed.projects) {
          const worktree = project.worktrees.find((tree) => tree.sessions.some((session) => session.id === id))

          if (worktree !== undefined) return { project, worktree }
        }

        return undefined
      }

      try {
        p.model.release()

        const ready = async (task: string) => {
          const id = await p.runSub(task, "--title", `s58 ${task}`)
          await answered(w, p, id, task)
          await until(`${task} idle`, () => p.idle(id), 30_000)
          const worktree = (await ls(w, p)).find((entry) => entry.id === id)?.worktree ?? ""
          expect(worktree !== "", `${task} has no worktree`)

          return { id, worktree }
        }

        const live = await ready("live")
        const dirty = await ready("dirty")
        await fs.writeFile(path.join(dirty.worktree, "notes.txt"), "mine\n")
        await archive(w, p, dirty.id)
        const kept = await ready("kept")
        await archive(w, p, kept.id, "--keep-worktree")
        const loose = await ready("loose")
        await git(w, loose.worktree, "commit", "-q", "--allow-empty", "-m", "loose")
        await archive(w, p, loose.id)

        const root = path.join(w.root, "s58-multi")
        const work = path.join(root, "work")
        await fs.mkdir(work, { recursive: true })

        for (const name of ["a", "b"]) {
          const dir = path.join(root, name)
          await fs.mkdir(dir)
          await fs.writeFile(path.join(dir, "f"), "x\n")

          for (const argv of [
            ["git", "init", "-q", "-b", "main"],
            ["git", "add", "f"],
            ["git", "commit", "-q", "-m", "f"],
          ]) {
            const ran = await w.run(dir, argv)
            expect(ran.code === 0, `${name} ${argv.join(" ")}: ${ran.stderr}`)
          }
        }

        const combo = path.join(work, "combo")
        await w.json(["project", "create", combo, "--from", path.join(root, "a"), "--from", path.join(root, "b")], {
          cwd: work,
        })
        const pi = await piDir(w, "pi-s58m", p.model.url)
        await w.entry({ cwd: combo, session: multi })

        const both = (
          JSON.parse(
            await w.okViaEntry(
              [
                "run",
                "pi",
                "--session",
                multi,
                "--env",
                `PI_CODING_AGENT_DIR=${pi}`,
                "--title",
                "s58 both",
                "--",
                ask("both"),
              ],
              { cwd: combo, timeoutMs: 90_000 },
            ),
          ) as { id: string }
        ).id

        await until(
          "both done",
          async () =>
            (
              (await w.json<{ reply: { text: string | null } | null }>(["result", both], { cwd: combo })).reply?.text ??
              ""
            ).includes("done-both"),
          90_000,
        )

        const bucket = path.dirname(live.worktree)
        await fs.writeFile(path.join(path.dirname(bucket), ".DS_Store"), "")
        await fs.writeFile(path.join(bucket, ".DS_Store"), "")
        await fs.symlink("dead", path.join(bucket, "dead"))
        const listed = await w.json<Listed>(["worktree", "list"], { cwd: p.repo, env: p.env })

        const expectTree = (id: string, title: string, sessionState: string, repo: (repository: Repo) => boolean) => {
          const found = find(listed, id)
          expect(found !== undefined, `${id} is not listed in ${JSON.stringify(listed)}`)
          const session = found!.worktree.sessions.find((row) => row.id === id)
          expect(
            session !== undefined && session.title === title && session.state === sessionState,
            `${id}: ${JSON.stringify(found)}`,
          )
          expect(
            found!.worktree.repositories.every(repo),
            `${id} repositories: ${JSON.stringify(found!.worktree.repositories)}`,
          )

          return found!
        }

        const detached = (repository: Repo) =>
          repository.branch === undefined && /^[0-9a-f]{7,}$/.test(repository.commit ?? "")

        const liveTree = expectTree(
          live.id,
          "s58 live",
          "live",
          (repository) => repository.state === "clean" && detached(repository),
        )

        expect(
          (await fs.realpath(liveTree.worktree.path)) === (await fs.realpath(live.worktree)),
          liveTree.worktree.path,
        )
        expect(liveTree.worktree.repositories.length === 1, JSON.stringify(liveTree.worktree.repositories))
        expect(
          (await fs.realpath(liveTree.worktree.repositories[0]!.folder)) === (await fs.realpath(live.worktree)),
          liveTree.worktree.repositories[0]!.folder,
        )

        const dirtyTree = expectTree(
          dirty.id,
          "s58 dirty",
          "archived",
          (repository) => repository.state === "dirty" && repository.changed === 1,
        )

        expect(
          (await fs.realpath(dirtyTree.worktree.path)) === (await fs.realpath(dirty.worktree)),
          dirtyTree.worktree.path,
        )
        expectTree(
          kept.id,
          "s58 kept",
          "archived",
          (repository) => repository.state === "clean" && detached(repository),
        )
        expectTree(
          loose.id,
          "s58 loose",
          "archived",
          (repository) => repository.state === "unsaved" && detached(repository),
        )

        const bothTree = expectTree(
          both,
          "s58 both",
          "live",
          (repository) => repository.state === "clean" && detached(repository),
        )

        expect(
          bothTree.worktree.repositories.map((repository) => path.basename(repository.folder)).join(",") === "a,b",
          JSON.stringify(bothTree.worktree.repositories),
        )
        expect(await same(bothTree.project.directory, combo), bothTree.project.directory)
        expect(await same(liveTree.project.directory, p.repo), liveTree.project.directory)

        const only = await w.json<Listed>(["worktree", "list", "--project", liveTree.project.id], {
          cwd: p.repo,
          env: p.env,
        })

        expect(
          only.projects.length === 1 && only.projects[0]!.id === liveTree.project.id,
          JSON.stringify(only.projects),
        )
        expect(!JSON.stringify(only).includes(both), "--project included the other project")
        const byFolder = await w.json<Listed>(["worktree", "list", "--project", p.repo], { cwd: p.repo, env: p.env })
        expect(
          byFolder.projects.length === 1 && byFolder.projects[0]!.id === liveTree.project.id,
          JSON.stringify(byFolder),
        )

        const missing = await w.vibest(["worktree", "list", "--project", "no-such-project"], {
          cwd: p.repo,
          env: p.env,
        })

        expect(missing.code !== 0 && missing.stderr.includes("no project"), missing.stderr)
        const fromAgent = await w.okViaEntry(["worktree", "list"], { cwd: p.repo, env: p.env, timeoutMs: 60_000 })
        expect(fromAgent.includes(live.id), "an agent cannot list worktrees")

        const index = await git(w, kept.worktree, "rev-parse", "--path-format=absolute", "--git-path", "index")
        await fs.rename(index, `${index}.ok`)
        await fs.writeFile(index, "bad")

        try {
          const unreadable = await w.json<Listed>(["worktree", "list"], { cwd: p.repo, env: p.env })
          const keptRepos = find(unreadable, kept.id)?.worktree.repositories ?? []
          expect(
            keptRepos.length === 1 && keptRepos[0]!.state === "unknown",
            `a worktree git cannot read: ${JSON.stringify(keptRepos)}`,
          )
          expect(find(unreadable, live.id) !== undefined, "an unreadable worktree hid the others")
        } finally {
          await fs.rename(`${index}.ok`, index)
        }
      } finally {
        await dropHerdrSession(w, multi)
        await p.close()
      }
    },
  },
]

export default [...checks, ...sessionStop]
