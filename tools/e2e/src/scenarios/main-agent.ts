import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, heldModel, type Message, piDir, reply, sseHeaders, text, toolCall } from "../fake-model.ts"
import { alive, expect, fail, herdr, row, SESSIONS, Skip, until, type World } from "../world.ts"
import { dropHerdrSession, project } from "./inbox.ts"

type Proc = { name: string; argv?: Array<string> | null }
type Main = { id: string; directory: string; conversation: string | null; runtime: string | null }

const needs = (...bins: Array<string>) => {
  for (const bin of bins) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
}

const socketOf = (w: World, session: string) => path.join(w.home, ".config", "herdr", "sessions", session, "herdr.sock")

const panes = async (socket: string) =>
  ((await herdr(socket, "pane.list", {}).catch(() => ({ panes: [] }))) as { panes: Array<{ pane_id: string }> }).panes

const piArgv = async (socket: string, pane: string) => {
  const info = (await herdr(socket, "pane.process_info", { pane_id: pane }).catch(() => ({}))) as {
    process_info?: { foreground_processes?: Array<Proc> }
  }
  for (const p of info.process_info?.foreground_processes ?? []) {
    const argv = p.argv ?? []
    if ([p.name, ...argv.slice(0, 2)].some((n) => path.basename(n) === "pi")) return argv
  }
  return undefined
}

const piPane = async (socket: string) => {
  for (const p of await panes(socket)) {
    const argv = await piArgv(socket, p.pane_id)
    if (argv) return { pane: p.pane_id, argv }
  }
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

const flag = (argv: ReadonlyArray<string>, name: string) => {
  const at = argv.indexOf(name)
  return at === -1 ? undefined : argv[at + 1]
}

const liveMain = (w: World) =>
  row<Main>(
    w,
    `SELECT s.id, s.directory, s.harness_session_id AS conversation, s.runtime FROM ${SESSIONS} s
     WHERE s.agent_type = 'main' AND s.ended_at IS NULL ORDER BY s.created_at DESC LIMIT 1`,
  )

const processStarts = (w: World) =>
  row<{ n: number }>(
    w,
    "SELECT count(*) AS n FROM event e JOIN session s ON s.id = e.session_id WHERE s.role = 'main' AND e.type = 'process.start'",
  )?.n ?? 0

const piReady = async (socket: string, what: string) => {
  let found: { pane: string; argv: Array<string> } | undefined
  await until(
    `${what}: pi running`,
    async () => {
      found = await piPane(socket)
      return found !== undefined
    },
    60_000,
  )
  await until(`${what}: pi idle`, async () => ["idle", "done"].includes(await status(socket, found!.pane)), 60_000)
  return found!
}

const turn = async (w: World, socket: string, pane: string, prompt: string, answer: string) => {
  await herdr(socket, "agent.prompt", { target: pane, text: prompt })
  await until(`the answer ${answer} on screen`, async () => (await screen(socket, pane)).includes(answer), 60_000)
  await until("the main agent's conversation", () => (liveMain(w)?.conversation ?? null) !== null, 30_000)
  await until(
    "the main agent idle after its turn",
    async () => ["idle", "done"].includes(await status(socket, pane)),
    60_000,
  )
}

const exitMain = async (w: World, socket: string, pane: string, id: string) => {
  const pid = row<{ p: number | null }>(w, `SELECT pid AS p FROM ${SESSIONS} s WHERE id = ?`, id)?.p
  expect(pid != null, `no pid for the main agent ${id}`)
  await herdr(socket, "pane.close", { pane_id: pane })
  await until("the main agent's harness gone", () => !alive(pid!), 30_000)
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
      "`vibest` from a plain terminal in a subdirectory opens the main agent in this run's herdr session at the repository root (the parent workspace), and its system prompt is $TMPDIR/vibest/<id>/system-prompt.md naming the project folder",
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
        expect(out.includes("the main agent is starting in"), `vibest printed: ${out}`)
        const socket = socketOf(w, w.herdrSession)
        const { argv } = await piReady(socket, "the launched main agent")
        await until("the main agent's row", () => liveMain(w) !== undefined, 30_000)
        const main = liveMain(w)!
        const root = await fs.realpath(w.repository)
        expect(main.directory === root, `main agent directory ${main.directory}, not ${root}`)
        const terminal = (JSON.parse(main.runtime ?? "{}") as { id?: string }).id ?? ""
        expect(terminal.startsWith(`${w.herdrSession}/`), `main agent terminal ${terminal}`)
        const file = path.join(w.root, "tmp", "vibest", main.id, "system-prompt.md")
        expect(flag(argv, "--system-prompt") === file, `pi argv: ${JSON.stringify(argv)}`)
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
      "a Pi main agent whose pane closed after a turn: `vibest` reopens the same session and conversation (pi --session-id, the earlier prompt on screen); `vibest --new` starts a new session and conversation (no --session-id, the earlier prompt not on screen)",
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
          await w.startMain({ harness: "pi", session, env, extra, timeoutMs: 60_000 })
          await until(`${what}: a new process`, () => processStarts(w) > before, 60_000)
          return piReady(socket, what)
        }
        const first = await start([], "the first main agent")
        const prompt = ask("first")
        await turn(w, socket, first.pane, prompt, "done-first")
        const one = liveMain(w)!
        await exitMain(w, socket, first.pane, one.id)

        const again = await start([], "the reopened main agent")
        expect(liveMain(w)?.id === one.id, `reopened ${liveMain(w)?.id}, not ${one.id}`)
        expect(
          flag(again.argv, "--session-id") === one.conversation,
          `pi argv: ${JSON.stringify(again.argv)}, conversation ${one.conversation}`,
        )
        await until(
          "the earlier prompt on the reopened screen",
          async () => (await screen(socket, again.pane)).includes("done-first"),
          30_000,
        )
        await exitMain(w, socket, again.pane, one.id)

        const fresh = await start(["--new"], "the --new main agent")
        const two = liveMain(w)!
        expect(two.id !== one.id, `--new kept session ${one.id}`)
        expect(
          two.conversation !== one.conversation && !fresh.argv.includes("--session-id"),
          `--new resumed ${two.conversation}: ${JSON.stringify(fresh.argv)}`,
        )
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
      "a Pi main agent's turn of two bash calls and a read (fake model) renders as one collapsed tool group: `Read 1 file · Ran 2 shell commands`",
    run: async (w) => {
      needs("pi", "herdr")
      const model = toolsModel(path.join(w.repository, "README.md"))
      const session = `${w.herdrSession}-tools`
      const socket = socketOf(w, session)
      try {
        const env = { PI_CODING_AGENT_DIR: await piDir(w, "pi-tools", model.url) }
        await w.daemon({ env })
        await w.startMain({ harness: "pi", session, env, timeoutMs: 60_000 })
        const { pane } = await piReady(socket, "the main agent")
        await herdr(socket, "agent.prompt", { target: pane, text: "group-tools" })
        await until("the turn's reply", async () => (await screen(socket, pane)).includes("tools-done"), 60_000)
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
      "several repositories: each is its own Project (also from a subdirectory or a linked worktree); a nested repository and another clone of the same origin are other Projects; Pi runs in two repositories at once get worktrees of their own repository and their own results",
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
        const run = async (cwd: string, task: string) =>
          (
            JSON.parse(await w.ok(["run", "pi", "--env", env, "--", ask(task)], { cwd, timeoutMs: 60_000 })) as {
              id: string
            }
          ).id
        const [inShop, inAdmin] = await Promise.all([run(shop, "shop"), run(admin, "admin")])
        for (const [id, cwd, task, repo] of [
          [inShop!, shop, "shop", shop],
          [inAdmin!, admin, "admin", admin],
        ] as const) {
          await until(
            `the ${task} result`,
            async () =>
              (
                (await w.json<{ result?: { message?: string } | null }>(["result", id], { cwd })).result?.message ?? ""
              ).includes(`done-${task}`),
            90_000,
          )
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
]

export default checks
