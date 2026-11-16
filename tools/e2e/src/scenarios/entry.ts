import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, entryRun, heldModel, type Message, piDir, reply, sseHeaders, text, toolCall } from "../fake-model.ts"
import { replyOf, expect, fail, herdr, row, SESSIONS, Skip, until, type World } from "../world.ts"
import { dropHerdrSession, project } from "./inbox.ts"

type Proc = { name: string; argv0?: string | null; argv?: Array<string> | null }
type Pane = { pane_id: string; agent?: string | null }
type EntryRow = { id: string; directory: string; conversation: string | null; runtime: string | null }

const needs = (...bins: Array<string>) => {
  for (const bin of bins) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
}

const socketOf = (w: World, session: string) => path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")

const panes = async (socket: string) =>
  ((await herdr(socket, "pane.list", {}).catch(() => ({ panes: [] }))) as { panes: Array<Pane> }).panes

const runsPi = async (socket: string, pane: Pane) => {
  if (pane.agent === "pi") return true
  const info = (await herdr(socket, "pane.process_info", { pane_id: pane.pane_id }).catch(() => ({}))) as {
    process_info?: { foreground_processes?: Array<Proc> }
  }
  return (info.process_info?.foreground_processes ?? []).some((p) =>
    [p.name, p.argv0, ...(p.argv ?? []).slice(0, 2)].some((n) => n != null && path.basename(n) === "pi"),
  )
}

const piPane = async (socket: string) => {
  for (const p of await panes(socket)) if (await runsPi(socket, p)) return p.pane_id
  return undefined
}

const screen = async (socket: string, pane: string) =>
  (
    (await herdr(socket, "pane.read", { pane_id: pane, source: "visible", strip_ansi: true })) as {
      read: { text: string }
    }
  ).read.text

const status = async (socket: string, pane: string) =>
  ((await herdr(socket, "pane.get", { pane_id: pane })) as { pane: { agent_status: string } }).pane.agent_status

const liveEntry = (w: World) =>
  row<EntryRow>(
    w,
    `SELECT s.id, s.directory, s.harness_session_id AS conversation, s.runtime FROM ${SESSIONS} s
     WHERE s.agent_type = 'coordinator' AND s.ended_at IS NULL ORDER BY s.created_at DESC LIMIT 1`,
  )

const processStarts = (w: World) =>
  row<{ n: number }>(
    w,
    "SELECT count(*) AS n FROM process p JOIN session s ON s.id = p.session_id WHERE s.agent = 'coordinator'",
  )?.n ?? 0

const latestProcess = (w: World) =>
  row<{ ready: number | null; conversation: string | null }>(
    w,
    `SELECT p.ready_at AS ready, p.conversation FROM process p JOIN session s ON s.id = p.session_id
     WHERE s.agent = 'coordinator' ORDER BY p.started_at DESC, p.id DESC LIMIT 1`,
  )

const piReady = async (socket: string, what: string) => {
  let pane: string | undefined
  await until(
    `${what}: pi running`,
    async () => {
      pane = await piPane(socket)
      return pane !== undefined
    },
    60_000,
  )
  await until(`${what}: pi idle`, async () => ["idle", "done"].includes(await status(socket, pane!)), 60_000)
  return { pane: pane! }
}

const readyConversation = async (w: World, what: string) => {
  await until(
    `${what}: the process ready with its conversation`,
    () => {
      const p = latestProcess(w)
      return p?.ready != null && p.conversation !== null
    },
    30_000,
  )
  return latestProcess(w)!.conversation
}

const execution = async (w: World, socket: string, pane: string, prompt: string, answer: string) => {
  await herdr(socket, "agent.prompt", { target: pane, text: prompt })
  await until(`the answer ${answer} on screen`, async () => (await screen(socket, pane)).includes(answer), 60_000)
  await until("the entry session's conversation", () => (liveEntry(w)?.conversation ?? null) !== null, 30_000)
  await until(
    "the entry session idle after its execution",
    async () => ["idle", "done"].includes(await status(socket, pane)),
    60_000,
  )
}

const exitEntry = async (w: World, socket: string, pane: string, id: string) => {
  await herdr(socket, "pane.close", { pane_id: pane })
  await until(
    "the entry session's process.end",
    () => row<{ e: number | null }>(w, `SELECT exited_at AS e FROM ${SESSIONS} s WHERE id = ?`, id)?.e != null,
    30_000,
  )
}

const toolsModel = (readme: string) => {
  let calls = 0
  const steps = [
    { name: "bash", input: { command: "echo grp-alpha" } },
    { name: "bash", input: { command: "echo grp-beta" } },
    { name: "read", input: { path: readme } },
  ]
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<Message> }
      const entryAnswer = entryRun(messages)
      if (entryAnswer !== undefined) return new Response(entryAnswer, { headers: sseHeaders })
      const user = messages.findLastIndex((m) => m.role === "user")
      const done = messages.slice(user + 1).filter((m) => m.role === "tool").length
      const step = text(messages[user]).includes("group-tools") ? steps[done] : undefined
      const body = step === undefined ? reply("tools-done") : toolCall(`call${++calls}`, step.name, step.input)
      return new Response(body, { headers: sseHeaders })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "S10-launch",
    title:
      "`vibest` from a plain terminal in a subdirectory opens the entry session in this run's herdr session at the repository root (the parent workspace), and its system prompt (appended to Pi's own) is $TMPDIR/vibest/<id>/system-prompt.md naming the project folder",
    run: async (w) => {
      needs("pi", "herdr")
      const model = heldModel()
      model.release()
      try {
        const env = { PI_CODING_AGENT_DIR: await piDir(w, "pi-launch", model.url) }
        await w.daemon({ env })
        const sub = path.join(w.repository, "src")
        await fs.mkdir(sub)
        const out = await w.ok(["--harness", "pi", "--headless"], { cwd: sub, env, timeoutMs: 60_000 })
        expect(out.includes("the entry session is starting in"), `vibest printed: ${out}`)
        const socket = socketOf(w, w.herdrSession)
        const { pane } = await piReady(socket, "the launched entry session")
        await until("the entry session's row", () => liveEntry(w) !== undefined, 30_000)
        const entry = liveEntry(w)!
        const root = await fs.realpath(w.repository)
        expect(entry.directory === root, `entry session directory ${entry.directory}, not ${root}`)
        const terminal = (JSON.parse(entry.runtime ?? "{}") as { id?: string }).id ?? ""
        expect(terminal.startsWith(`${w.herdrSession}/`), `entry session terminal ${terminal}`)
        const file = path.join(w.root, "tmp", "vibest", entry.id, "system-prompt.md")
        await until(
          "Pi lists the system prompt file in its loaded context",
          async () => (await screen(socket, pane)).replace(/\s+/g, "").includes(file),
          30_000,
        ).catch(async (e: Error) => fail(`${e.message}: ${file}; screen:\n${await screen(socket, pane)}`))
        const info = await w.json<{ directory: string }>(["project", "info"])
        expect((await Bun.file(file).text()).includes(info.directory), `${file} does not name ${info.directory}`)
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "S10-resume",
    title:
      "a Pi entry session whose execution shows in `vibest ls` and `vibest result` and whose pane closed after it: `vibest` reopens the same session and conversation (its new process reports that conversation, the earlier prompt on screen); `vibest --new` starts a new session and conversation (another conversation reported, the earlier prompt not on screen)",
    run: async (w) => {
      needs("pi", "herdr")
      const model = heldModel()
      model.release()
      const session = w.herdrSession
      const socket = socketOf(w, session)
      try {
        const env = { PI_CODING_AGENT_DIR: await piDir(w, "pi-resume", model.url) }
        await w.daemon({ env })
        const start = async (extra: ReadonlyArray<string>, what: string) => {
          const before = processStarts(w)
          await w.startEntry({ harness: "pi", session, env, extra, timeoutMs: 60_000 })
          await until(`${what}: a new process`, () => processStarts(w) > before, 60_000)
          return piReady(socket, what)
        }
        const first = await start([], "the first entry session")
        const prompt = ask("first")
        await execution(w, socket, first.pane, prompt, "done-first")
        const one = liveEntry(w)!
        await until(
          "Pi saved the conversation",
          () => Bun.spawnSync(["find", `${env.PI_CODING_AGENT_DIR}/sessions`, "-name", "*.jsonl"]).stdout.length > 0,
          30_000,
        )
        const resultOf = await w.json<{ reply?: { text: string | null } | null }>(["result", one.id], {
          cwd: w.repository,
        })
        expect(
          resultOf.reply?.text?.includes("done-first") === true,
          `result of the entry session: ${JSON.stringify(resultOf)}`,
        )
        const listing = await w.json<{ sessions: Array<{ id: string; executionState: string }> }>(["ls"], {
          cwd: w.repository,
        })
        expect(
          listing.sessions.find((e) => e.id === one.id)?.executionState === "completed",
          `vibest ls: ${JSON.stringify(listing.sessions.map((e) => [e.id, e.executionState]))}`,
        )
        await exitEntry(w, socket, first.pane, one.id)

        const again = await start([], "the reopened entry session")
        expect(liveEntry(w)?.id === one.id, `reopened ${liveEntry(w)?.id}, not ${one.id}`)
        const resumed = await readyConversation(w, "the reopened entry session")
        expect(resumed === one.conversation, `reopened conversation ${resumed}, not ${one.conversation}`)
        await until(
          "the earlier prompt on the reopened screen",
          async () => (await screen(socket, again.pane)).includes("done-first"),
          30_000,
        )
        await exitEntry(w, socket, again.pane, one.id)

        const fresh = await start(["--new"], "the --new entry session")
        const two = liveEntry(w)!
        expect(two.id !== one.id, `--new kept session ${one.id}`)
        const started = await readyConversation(w, "the --new entry session")
        expect(started !== one.conversation, `--new resumed conversation ${started}`)
        const shown = await screen(socket, fresh.pane)
        if (shown.includes("done-first")) fail(`--new shows the old conversation:\n${shown}`)
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S12-tools",
    title:
      "a Pi entry session's execution of two bash calls and a read (fake model) renders as one collapsed tool group: `Read 1 file · Ran 2 shell commands`",
    run: async (w) => {
      needs("pi", "herdr")
      const model = toolsModel(path.join(w.repository, "README.md"))
      const session = `${w.herdrSession}-tools`
      const socket = socketOf(w, session)
      try {
        const env = { PI_CODING_AGENT_DIR: await piDir(w, "pi-tools", model.url) }
        await w.daemon({ env })
        await w.startEntry({ harness: "pi", session, env, timeoutMs: 60_000 })
        const { pane } = await piReady(socket, "the entry session")
        await herdr(socket, "agent.prompt", { target: pane, text: "group-tools" })
        await until("the execution's reply", async () => (await screen(socket, pane)).includes("tools-done"), 60_000)
        await until(
          "one tool group line",
          async () => (await screen(socket, pane)).includes("Read 1 file · Ran 2 shell commands"),
          10_000,
        ).catch(async (e: Error) => fail(`${e.message}; screen:\n${await screen(socket, pane)}`))
      } finally {
        model.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "S14",
    title:
      "several repositories: each is its own Project (also from a subdirectory or a linked worktree); a nested repository and another clone of the same origin are other Projects; Pi runs in two repositories at once get worktrees of their own repository and their own answers",
    run: async (w) => {
      needs("pi", "herdr", "git")
      const git = async (cwd: string, ...args: Array<string>) => {
        const r = await w.run(cwd, ["git", ...args])
        expect(r.code === 0, `git ${args.join(" ")}: ${r.stderr}`)
        return r.stdout.trim()
      }
      const info = (cwd: string) => w.json<{ directory: string }>(["project", "info"], { cwd }).then((i) => i.directory)
      const shop = w.repository
      await fs.writeFile(path.join(shop, ".gitignore"), "vendor/\n")
      await git(shop, "add", ".gitignore")
      await git(shop, "commit", "-q", "-m", "ignore vendor")
      await git(shop, "push", "-q")
      const sdk = path.join(shop, "vendor", "sdk")
      await fs.mkdir(sdk, { recursive: true })
      await git(sdk, "init", "-q", "-b", "main")
      await git(sdk, "commit", "-q", "--allow-empty", "-m", "init")
      const admin = await project(w, "admin")
      const copy = path.join(w.root, "shop-copy")
      await git(w.root, "clone", "-q", w.origin, copy)
      const linked = path.join(w.root, "shop-wt")
      await git(shop, "worktree", "add", "-q", "--detach", linked)
      await fs.mkdir(path.join(shop, "src"))

      const shopProject = await info(shop)
      const adminProject = await info(admin)
      expect(adminProject !== shopProject, "admin shares shop's Project")
      expect((await info(path.join(shop, "src"))) === shopProject, "shop/src is another Project")
      expect((await info(linked)) === shopProject, "a linked worktree of shop is another Project")
      expect(![shopProject, adminProject].includes(await info(sdk)), "the nested repository is shop's Project")
      expect(
        ![shopProject, adminProject].includes(await info(copy)),
        "another clone of shop's origin is shop's Project",
      )

      const model = heldModel()
      model.release()
      try {
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-repos", model.url)}`
        await w.daemon()
        await w.entry({ cwd: shop })
        await w.entry({ cwd: admin })
        const run = async (cwd: string, task: string) =>
          (
            JSON.parse(
              await w.okViaEntry(["run", "pi", "--env", env, "--", ask(task)], { cwd, timeoutMs: 60_000 }),
            ) as {
              id: string
            }
          ).id
        const [inShop, inAdmin] = await Promise.all([run(shop, "shop"), run(admin, "admin")])
        for (const [id, cwd, task, repo] of [
          [inShop!, shop, "shop", shop],
          [inAdmin!, admin, "admin", admin],
        ] as const) {
          await until(`the ${task} answer`, async () => (await replyOf(w, id, cwd)).includes(`done-${task}`), 90_000)
          const dir = row<{ d: string }>(w, "SELECT directory AS d FROM session WHERE id = ?", id)!.d
          expect(dir !== repo, `${task}'s run works in the checkout itself`)
          const common = await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
          expect(common === (await fs.realpath(path.join(repo, ".git"))), `${task}'s worktree belongs to ${common}`)
          if (task === "shop")
            expect(
              !(await Bun.file(path.join(dir, "vendor", "sdk", ".git")).exists()),
              "shop's worktree holds vendor/sdk",
            )
          const other = task === "shop" ? admin : shop
          const listed = await w.json<{ sessions: Array<{ id: string }> }>(["ls", "--all"], { cwd: other })
          expect(!listed.sessions.some((e) => e.id === id), `${task}'s run is listed in the other repository`)
        }
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "S42",
    title:
      "agent definitions: the entry session is the coordinator and vibest run starts a general session; an unknown --agent is refused before any worktree is made",
    run: async (w) => {
      needs("pi", "herdr", "git")
      const model = heldModel()
      model.release()
      try {
        const env = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-agents", model.url)}`
        await w.daemon()
        await w.entry({ cwd: w.repository })
        const worktrees = async () => (await fs.readdir(path.join(w.vibestHome, "worktrees")).catch(() => [])).length
        const before = await worktrees()
        const refused = await w.viaEntry(["run", "--agent", "nosuch", "pi", "--env", env, "--", ask("no")])
        expect(
          refused.code !== 0 && refused.stderr.includes("nosuch"),
          `unknown agent: ${refused.code} ${refused.stderr}`,
        )
        expect((await worktrees()) === before, "a worktree was made for the unknown agent")
        const { id } = JSON.parse(await w.okViaEntry(["run", "pi", "--env", env, "--", ask("yes")])) as { id: string }
        expect(row<{ agent: string }>(w, "SELECT agent FROM session WHERE id = ?", id)?.agent === "general", "agent")
        expect(liveEntry(w)?.id !== undefined, "the entry session is not the coordinator")
      } finally {
        model.stop()
      }
    },
  },
]

export default checks
