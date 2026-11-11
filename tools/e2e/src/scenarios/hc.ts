import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, delegatingModel, piDir } from "../fake-model.ts"
import { binary, expect, row, SESSIONS, Skip, until, vibestd, type World } from "../world.ts"
import { project } from "./inbox.ts"

type Entry = { id: string; agent: string; status: string; executionState: string }
type Sample = { at: number; end: number; status: string; executionState: string }
type Watched = {
  _tag: string
  projects: Array<{ id: string; activity: string }>
  sessions: Array<{ id: string; projectId: string; status: string; finished: number | null }>
}
type HcListed = { address: string; name?: string | null; state: string }
type HcTerminal = {
  address: string
  name?: string | null
  parent?: string | null
  notify?: boolean
  state: string
  labels: Record<string, string>
}

const isolatedCore = async (w: World, piAgentDir: string, tag: string) => {
  const dirs = {
    state: path.join(w.root, `${tag}-state`),
    config: path.join(w.root, `${tag}-config`),
    runtime: path.join(w.root, `${tag}-runtime`),
  }
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true })
  const env = {
    HC_SESSION: tag,
    XDG_RUNTIME_DIR: dirs.runtime,
    XDG_STATE_HOME: dirs.state,
    XDG_CONFIG_HOME: dirs.config,
    PI_CODING_AGENT_DIR: piAgentDir,
    CLAUDE_CONFIG_DIR: undefined,
  }
  const hc = (...args: Array<string>) => w.run(w.root, ["hc", ...args], { env })
  const started = await hc("server", "start")
  expect(started.code === 0, `hc server start: ${started.stderr}${started.stdout}`)
  return {
    terminals: async () => {
      const listed = await hc("ls", "--all", "--json")
      expect(listed.code === 0, `hc ls: ${listed.stderr}`)
      return (JSON.parse(listed.stdout) as { terminals: Array<HcListed> }).terminals
    },
    hc,
    get: async (terminal: string) => JSON.parse((await hc("get", terminal, "--json")).stdout) as HcTerminal,
    screens: async () => {
      const listed = JSON.parse((await hc("ls", "--all", "--json")).stdout) as { terminals: Array<HcListed> }
      const shown: Array<string> = []
      for (const t of listed.terminals)
        shown.push(`--- ${t.address} ${t.name ?? ""} ${t.state}\n${(await hc("read", t.address)).stdout.trim()}`)
      return shown.join("\n")
    },
    stop: () => hc("server", "stop"),
  }
}

const addressOf = (id: string) => id.slice(0, id.indexOf("@"))

const configureRuntime = async (w: World, runtime: string | undefined) => {
  const file = path.join(w.vibestHome, "vibest.json")
  const before = await fs.readFile(file, "utf8").catch(() => undefined)
  const config = before === undefined ? {} : (JSON.parse(before) as Record<string, unknown>)
  await fs.writeFile(file, JSON.stringify({ ...config, runtime }))
  return () => (before === undefined ? fs.rm(file, { force: true }) : fs.writeFile(file, before))
}

const checks: ReadonlyArray<Check> = [
  {
    id: "S33",
    title:
      "herdr-core runtime: a Pi entry session started with --runtime hc runs `vibest run`, the subagent starts in hc as its child (no notes, outlives it), results and a send go both ways; the main terminal carries herdr.space=<project> and herdr.tab=<main session>, with readable project and task names",
    run: async (w) => {
      for (const bin of ["pi", "hc"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = delegatingModel("pi", { heldMs: 3_000 })
      w.ownRuntimes.add("hc")
      await w.stopDaemon()
      const piAgentDir = await piDir(w, "pi-hc", model.url)
      const env = `PI_CODING_AGENT_DIR=${piAgentDir}`
      const core = await isolatedCore(w, piAgentDir, "hc")
      try {
        const repo = await project(w, "hc")
        await w.startEntry({
          harness: "pi",
          runtime: "hc",
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: piAgentDir },
          processEnv: { CLAUDE_CONFIG_DIR: undefined },
          extra: ["--runtime", "hc"],
          name: "hc-main",
          hc: { run: core.hc },
          timeoutMs: 60_000,
        })
        let main = ""
        await until(
          "the entry session in vibest ls",
          async () => {
            main =
              (await w.json<{ sessions: Array<Entry> }>(["ls"], { cwd: repo }).then((l) => l.sessions)).find(
                (e) => e.agent === "main",
              )?.id ?? ""
            return main !== ""
          },
          60_000,
        )
        const reached = (what: string, marker: string) =>
          until(what, () => model.seen.some((m) => m.includes("<agent-") && m.includes(marker)), 180_000).catch(
            async (e: Error) => {
              throw new Error(
                `${e.message}; the model saw: ${JSON.stringify(model.seen, null, 1)}\nterminals:\n${await core.screens()}`,
              )
            },
          )
        const samples = new Map<string, Array<Sample>>()
        let sampling = true
        const sampler = (async () => {
          while (sampling) {
            const at = Date.now()
            const listed = await w
              .json<{ sessions: Array<Entry> }>(["ls"], { cwd: repo })
              .then((l) => l.sessions)
              .catch(() => [] as Array<Entry>)
            const end = Date.now()
            for (const e of listed)
              samples.set(e.id, [
                ...(samples.get(e.id) ?? []),
                { at, end, status: e.status, executionState: e.executionState },
              ])
            await Bun.sleep(100)
          }
        })()
        await w.okViaEntry(["run", "pi", "--runtime", "hc", "--env", env, "--title", "Fix login bug", ask("zero")], {
          cwd: repo,
          timeoutMs: 60_000,
        })
        await reached("the entry session's execution on the first result", "done-zero")
        await reached("the entry session's execution on the result of the subagent it started", "done-one")
        await reached("the entry session's execution on the result after its vibest send", "done-two")
        await until(
          "the entry session idle after its last execution",
          () => samples.get(main)?.at(-1)?.status === "idle",
          60_000,
        )
        sampling = false
        await sampler

        const runtimeOf = (id: string) =>
          JSON.parse(
            row<{ runtime: string }>(w, `SELECT runtime FROM ${SESSIONS} s WHERE id = ?`, id)?.runtime ?? "{}",
          ) as {
            kind?: string
            id?: string
          }
        const projectId = row<{ p: string }>(w, `SELECT project_id AS p FROM ${SESSIONS} s WHERE id = ?`, main)?.p
        const mainAt = runtimeOf(main)
        expect(mainAt.kind === "hc", `the entry session runs in ${JSON.stringify(mainAt)}, not hc`)
        const mainTerminal = await core.get(addressOf(mainAt.id!))
        expect(mainTerminal.name === "hc-main", `the main terminal name: ${mainTerminal.name}`)
        expect(mainAt.id === `${mainTerminal.address}@${w.hcSocket}`, `the main identity changed: ${mainAt.id}`)
        expect(
          mainTerminal.labels["herdr.space"] === projectId &&
            mainTerminal.labels["herdr.tab"] === main &&
            mainTerminal.labels["vibest.runtime"] === "hc" &&
            mainTerminal.labels["vibest.session"] === main &&
            mainTerminal.labels["vibest.project"] === projectId,
          `the main terminal's labels: ${JSON.stringify(mainTerminal.labels)} (project ${projectId}, main ${main})`,
        )
        const sub = model.sessionId()
        const subAt = runtimeOf(sub)
        expect(subAt.kind === "hc", `the subagent ${sub} runs in ${JSON.stringify(subAt)}, not hc`)
        const subTerminal = await core.get(addressOf(subAt.id!))
        const taskSlug = ask("one")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 27)
          .replace(/-+$/, "")
        expect(
          subTerminal.name === `${taskSlug}-${sub.slice(0, 4)}`,
          `the task-derived terminal name: ${subTerminal.name}`,
        )
        expect(subAt.id === `${subTerminal.address}@${w.hcSocket}`, `the subagent identity changed: ${subAt.id}`)
        expect(
          subTerminal.parent === mainTerminal.address &&
            subTerminal.notify === false &&
            subTerminal.labels["vibest.session"] === sub &&
            subTerminal.labels["vibest.project"] === projectId &&
            subTerminal.labels["herdr.space"] === undefined,
          `the subagent's terminal: ${JSON.stringify(subTerminal)}; main ${mainTerminal.address}`,
        )
        const shown = (id: string) =>
          JSON.stringify((samples.get(id) ?? []).map((x) => `${x.at % 100_000} ${x.status}/${x.executionState}`))
        const mainSeen = samples.get(main) ?? []
        const mainWorking = mainSeen.findIndex((x) => x.status === "working")
        expect(
          mainWorking >= 0 && mainSeen.slice(mainWorking).some((x) => x.status === "idle"),
          `the entry session was not seen working, then idle: ${shown(main)}`,
        )
        const subSeen = samples.get(sub) ?? []
        for (const marker of ["one", "two"]) {
          const execution = model.answered.find((t) => t.marker === marker)
          expect(execution !== undefined, `the model never answered the subagent's ${marker} task`)
          const during = subSeen.filter((x) => x.at > execution!.from + 500 && x.end < execution!.to)
          expect(
            during.length > 0 && during.every((x) => x.status === "working"),
            `the subagent was not shown working while the model held its ${marker} answer (${execution!.from % 100_000}-${execution!.to % 100_000}): ${shown(sub)}`,
          )
        }
        const listed = await core.terminals()
        const all = await Promise.all(listed.map((t) => core.get(t.address)))
        const titled = all.find((t) => t.parent === mainTerminal.address && t.address !== subTerminal.address)
        expect(
          titled !== undefined && titled.name === `fix-login-bug-${titled.labels["vibest.session"]?.slice(0, 4)}`,
          `the explicit-title terminal: ${JSON.stringify(titled)}`,
        )
        expect(
          all.every((t) => listed.find((entry) => entry.address === t.address)?.name === t.name),
          `hc ls and hc get names differ: ${JSON.stringify(listed)}`,
        )
        expect(
          all.every((t) => t.labels["vibest.runtime"] === "hc"),
          `terminals vibest did not label: ${JSON.stringify(all.filter((t) => t.labels["vibest.runtime"] !== "hc"))}`,
        )
      } finally {
        model.stop()
        await w.stopDaemon()
        await core.stop()
      }
    },
  },
  {
    id: "S34",
    title:
      "herdr-core runtime: `vibest --runtime hc` typed into a terminal of the user's own core starts the entry session in place, in that terminal on that core, and labels it for herdr-app",
    run: async (w) => {
      for (const bin of ["pi", "hc"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = delegatingModel("pi")
      w.ownRuntimes.add("hc")
      await w.stopDaemon()
      const piAgentDir = await piDir(w, "pi-hc-here", model.url)
      const core = await isolatedCore(w, piAgentDir, "hc-here")
      try {
        const repo = await project(w, "hc-here")
        const opened = await core.hc("run", "--bg", "--keep", "--name", "users-own", "--json")
        expect(opened.code === 0, `hc run: ${opened.stderr}${opened.stdout}`)
        const users = await core.get("users-own")
        await w.startEntry({
          harness: "pi",
          runtime: "hc",
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: piAgentDir },
          extra: ["--runtime", "hc"],
          hc: { run: core.hc, terminal: "users-own" },
          timeoutMs: 90_000,
        })
        let main = ""
        await until(
          "the entry session in vibest ls",
          async () => {
            main =
              (await w.json<{ sessions: Array<Entry> }>(["ls"], { cwd: repo }).then((l) => l.sessions)).find(
                (e) => e.agent === "main",
              )?.id ?? ""
            return main !== ""
          },
          90_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}\nterminals:\n${await core.screens()}`)
        })
        const at = JSON.parse(
          row<{ runtime: string }>(w, `SELECT runtime FROM ${SESSIONS} s WHERE id = ?`, main)?.runtime ?? "{}",
        ) as { kind?: string; id?: string }
        expect(
          at.kind === "hc" && at.id === `${users.address}@${w.hcSocket}`,
          `the entry session runs in ${JSON.stringify(at)}, not in ${users.address} on ${w.hcSocket}`,
        )
        const projectId = row<{ p: string }>(w, `SELECT project_id AS p FROM ${SESSIONS} s WHERE id = ?`, main)?.p
        await until(
          "herdr-app labels on the user's terminal",
          async () => {
            const { name, labels } = await core.get("users-own")
            return (
              name === "users-own" &&
              labels["vibest.runtime"] === "hc" &&
              labels["herdr.space"] === projectId &&
              labels["herdr.tab"] === main
            )
          },
          30_000,
        )
        const all = await core.terminals()
        expect(all.length === 1, `vibest opened terminals of its own: ${JSON.stringify(all)}`)
      } finally {
        model.stop()
        await w.stopDaemon()
        await core.stop()
      }
    },
  },
  {
    id: "S35",
    title:
      "herdr-core runtime: vibest typed into an isolated hc terminal with no --runtime starts the entry session there; the subagent it starts inherits hc; vibest run --runtime herdr places a subagent in this run's herdr",
    run: async (w) => {
      for (const bin of ["pi", "hc", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = delegatingModel("pi")
      w.ownRuntimes.add("hc")
      await w.stopDaemon()
      const piAgentDir = await piDir(w, "pi-follow", model.url)
      const env = `PI_CODING_AGENT_DIR=${piAgentDir}`
      const core = await isolatedCore(w, piAgentDir, "follow")
      try {
        const repo = await project(w, "follow")
        const opened = await core.hc("run", "--bg", "--keep", "--name", "caller", "--json")
        expect(opened.code === 0, `hc run: ${opened.stderr}${opened.stdout}`)
        const caller = await core.get("caller")
        const which = path.join(w.root, "which-vibest")
        const looked = await core.hc("send", "caller", `command -v vibest > '${which}'`)
        expect(looked.code === 0, `hc send command -v: ${looked.stderr}`)
        await until(
          "command -v vibest is this build",
          async () => (await fs.readFile(which, "utf8").catch(() => "")).trim() === binary,
          30_000,
        ).catch(async (e: Error) => {
          throw new Error(
            `${e.message}; command -v vibest wrote ${JSON.stringify(await fs.readFile(which, "utf8").catch(() => ""))}; screen:\n${await core.screens()}`,
          )
        })
        await w.startEntry({
          harness: "pi",
          runtime: "hc",
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: piAgentDir },
          hc: { run: core.hc, terminal: "caller" },
          timeoutMs: 90_000,
        })
        const runtimeOf = (id: string) =>
          JSON.parse(
            row<{ runtime: string }>(w, `SELECT runtime FROM ${SESSIONS} s WHERE id = ?`, id)?.runtime ?? "{}",
          ) as {
            kind?: string
            id?: string
          }
        let main = ""
        await until(
          "the entry session in vibest ls",
          async () => {
            main =
              (await w.json<{ sessions: Array<Entry> }>(["ls"], { cwd: repo }).then((l) => l.sessions)).find(
                (e) => e.agent === "main",
              )?.id ?? ""
            return main !== ""
          },
          90_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}\nterminals:\n${await core.screens()}`)
        })
        const mainAt = runtimeOf(main)
        expect(
          mainAt.kind === "hc" && mainAt.id === `${caller.address}@${w.hcSocket}`,
          `the entry session runs in ${JSON.stringify(mainAt)}, not in ${caller.address} on ${w.hcSocket}`,
        )
        await w.okViaEntry(["run", "pi", "--runtime", "hc", "--env", env, "--title", "Wake parent", ask("zero")], {
          cwd: repo,
          timeoutMs: 60_000,
        })
        await until("the entry session starts a subagent", () => model.sessionId() !== "", 180_000).catch(
          async (e: Error) => {
            throw new Error(
              `${e.message}; the model saw: ${JSON.stringify(model.seen, null, 1)}\nterminals:\n${await core.screens()}`,
            )
          },
        )
        const sub = model.sessionId()
        await until(
          "the inherited subagent's terminal",
          () => {
            const at = runtimeOf(sub)
            return at.kind === "hc" && at.id !== undefined && at.id !== ""
          },
          60_000,
        )
        const subAt = runtimeOf(sub)
        expect(
          subAt.kind === "hc" && subAt.id?.endsWith(`@${w.hcSocket}`) === true,
          `the subagent runs in ${JSON.stringify(subAt)}`,
        )
        const subTerminal = await core.get(addressOf(subAt.id!))
        expect(
          subTerminal.parent === caller.address,
          `the subagent's parent is ${subTerminal.parent}, not ${caller.address}`,
        )
        const placed = JSON.parse(
          await w.okViaEntry(
            ["run", "pi", "--runtime", "herdr", "--env", env, "--title", "Place in herdr", ask("side")],
            {
              cwd: repo,
              timeoutMs: 90_000,
            },
          ),
        ) as { id: string }
        await until(
          "the herdr subagent's terminal",
          () => runtimeOf(placed.id).id?.startsWith(`${w.herdrSession}/`) === true,
          60_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}; runtime ${JSON.stringify(runtimeOf(placed.id))}`)
        })
        const herdrAt = runtimeOf(placed.id)
        expect(herdrAt.kind === "herdr", `the herdr subagent runs in ${JSON.stringify(herdrAt)}`)
      } finally {
        model.stop()
        await w.stopDaemon()
        await core.stop()
      }
    },
  },
  {
    id: "S36",
    title:
      "herdr-core runtime: a subagent execution that ended unwatched is done in Watch, for it and its project; Session.Seen raises herdr.seen to that execution and it is idle",
    run: async (w) => {
      for (const bin of ["pi", "hc"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = delegatingModel("pi")
      w.ownRuntimes.add("hc")
      await w.stopDaemon()
      const piAgentDir = await piDir(w, "pi-hc-seen", model.url)
      const env = `PI_CODING_AGENT_DIR=${piAgentDir}`
      const core = await isolatedCore(w, piAgentDir, "hc-seen")
      const restore = await configureRuntime(w, "hc")
      try {
        const repo = await project(w, "hc-seen")
        await w.startEntry({
          harness: "pi",
          runtime: "hc",
          cwd: repo,
          env: { PI_CODING_AGENT_DIR: piAgentDir },
          processEnv: { CLAUDE_CONFIG_DIR: undefined },
          extra: ["--runtime", "hc"],
          hc: { run: core.hc },
          timeoutMs: 60_000,
        })
        await until(
          "the entry session in vibest ls",
          async () =>
            (await w.json<{ sessions: Array<Entry> }>(["ls"], { cwd: repo }).then((l) => l.sessions)).some(
              (e) => e.agent === "main",
            ),
          60_000,
        )
        const sub = (
          JSON.parse(
            await w.okViaEntry(
              ["run", "pi", "--runtime", "hc", "--env", env, "--title", "Check seen state", "--", ask("seen")],
              {
                cwd: repo,
                timeoutMs: 60_000,
              },
            ),
          ) as { id: string }
        ).id
        let last: Watched | undefined
        const snapshot = async () => {
          const answer = await vibestd(w, repo, "Watch", null)
          const first = (answer.result as Array<Watched> | undefined)?.[0]
          expect(first?._tag === "Snapshot", `Watch did not answer a Snapshot: ${JSON.stringify(answer).slice(0, 400)}`)
          last = first
          return first!
        }
        const subOf = (watched: Watched) => watched.sessions.find((s) => s.id === sub)
        await until(
          "the subagent done in Watch after its execution",
          async () => {
            const s = subOf(await snapshot())
            return s?.status === "done" && (s.finished ?? 0) >= 1
          },
          180_000,
        ).catch(async (e: Error) => {
          throw new Error(`${e.message}; last Watch: ${JSON.stringify(last)}\nterminals:\n${await core.screens()}`)
        })
        const { finished, projectId } = subOf(last!)!
        expect(
          last!.projects.find((p) => p.id === projectId)?.activity === "done",
          `the project is not done: ${JSON.stringify(last!.projects)}`,
        )
        const marked = await vibestd(w, repo, "Session.Seen", { id: sub, finished })
        expect(marked.error === undefined, `Session.Seen: ${JSON.stringify(marked)}`)
        await until(
          "the subagent idle after Session.Seen",
          async () => subOf(await snapshot())?.status === "idle",
          30_000,
        ).catch((e: Error) => {
          throw new Error(`${e.message}; last Watch: ${JSON.stringify(last)}`)
        })
        const at = JSON.parse(
          row<{ runtime: string }>(w, `SELECT runtime FROM ${SESSIONS} s WHERE id = ?`, sub)?.runtime ?? "{}",
        ) as { id?: string }
        const labels = (await core.get(addressOf(at.id!))).labels
        expect(labels["herdr.seen"] === String(finished), `herdr.seen ${labels["herdr.seen"]}, finished ${finished}`)
      } finally {
        model.stop()
        await w.stopDaemon()
        await restore()
        await core.stop()
      }
    },
  },
]

export default checks
