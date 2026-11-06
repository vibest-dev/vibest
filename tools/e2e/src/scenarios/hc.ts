import fs from "node:fs/promises"
import path from "node:path"

import { shellQuote } from "../../../../packages/schema/src/layout.ts"
import type { Check } from "../check.ts"
import { ask, delegatingModel, piDir } from "../fake-model.ts"
import { binary, expect, herdr, row, SESSIONS, Skip, until, type World } from "../world.ts"
import { project } from "./inbox.ts"

type Entry = { id: string; agent: string; status: string; turnState: string }
type Sample = { at: number; end: number; status: string; turnState: string }
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
  const zdot = path.join(w.root, `zdotdir-${tag}`)
  for (const dir of [...Object.values(dirs), zdot]) await fs.mkdir(dir, { recursive: true })
  const env = {
    HC_SESSION: tag,
    XDG_RUNTIME_DIR: dirs.runtime,
    XDG_STATE_HOME: dirs.state,
    XDG_CONFIG_HOME: dirs.config,
    ZDOTDIR: zdot,
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
    env,
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
    id: "S35",
    title:
      "caller runtime: vibest typed in hc nested inside a live herdr pane needs no --runtime; its main and subagents stay in hc while another agent runs in herdr",
    run: async (w) => {
      for (const bin of ["pi", "hc", "herdr"]) if (!Bun.which(bin)) throw new Skip(bin + " not on PATH")
      w.ownRuntimes.add("hc")
      await w.stopDaemon()
      const model = delegatingModel("pi")
      const piAgentDir = await piDir(w, "pi-nested", model.url)
      const core = await isolatedCore(w, piAgentDir, "nested")
      const restore = await configureRuntime(w, undefined)
      const socket = path.join(w.home, ".config", "herdr", "sessions", w.herdrSession, "herdr.sock")
      w.spawn(["herdr", "server", "--session", w.herdrSession], path.join(w.root, "nested-herdr.log"))
      try {
        const repo = await project(w, "nested")
        await until(
          "isolated herdr ready",
          () =>
            fs.stat(socket).then(
              () => true,
              () => false,
            ),
          30_000,
        )
        await w.ok(["daemon"], { env: core.env })
        const created = await herdr(socket, "workspace.create", { cwd: repo, env: w.env(core.env), focus: false })
        const pane = (created.root_pane as { pane_id: string }).pane_id
        const command =
          'hc run --keep --name nested -- /usr/bin/env "HERDR_PANE_ID=$HERDR_PANE_ID" "HERDR_SOCKET_PATH=$HERDR_SOCKET_PATH" /bin/zsh -l'
        await herdr(socket, "pane.send_text", { pane_id: pane, text: command })
        await herdr(socket, "pane.send_keys", { pane_id: pane, keys: ["enter"] })
        await until(
          "hc terminal nested in herdr",
          async () => (await core.terminals()).some((t) => t.name === "nested"),
          30_000,
        )
        const inner = await core.get("nested")
        const typed = await core.hc(
          "send",
          "nested",
          "cd " +
            shellQuote(repo) +
            " && " +
            shellQuote(binary) +
            " --harness pi --env " +
            shellQuote("PI_CODING_AGENT_DIR=" + piAgentDir),
        )
        expect(typed.code === 0, "typed vibest: " + typed.stderr)
        let main = ""
        await until(
          "main in nested hc",
          async () => {
            main = (await w.json<Array<Entry>>(["ls"], { cwd: repo })).find((e) => e.agent === "main")?.id ?? ""
            return main !== ""
          },
          90_000,
        ).catch(async (error: Error) => {
          throw new Error(error.message + "\n" + (await core.screens()))
        })
        const runtimeOf = (id: string) =>
          JSON.parse(
            row<{ runtime: string }>(w, `SELECT runtime FROM ${SESSIONS} s WHERE id = ?`, id)?.runtime ?? "{}",
          ) as { kind?: string; id?: string }
        expect(
          runtimeOf(main).kind === "hc" && runtimeOf(main).id === inner.address + "@" + w.hcSocket,
          "main adopted the outer pane: " + JSON.stringify(runtimeOf(main)),
        )
        const seed = await w.json<{ id: string }>(
          ["run", "pi", "--env", "PI_CODING_AGENT_DIR=" + piAgentDir, ask("zero")],
          { cwd: repo, timeoutMs: 90_000 },
        )
        expect(runtimeOf(seed.id).kind === "herdr", "outside-runtime creation no longer uses the default")
        await until(
          "hc main creates and continues its hc subagent",
          () => model.seen.some((m) => m.includes("<agent-") && m.includes("done-two")),
          180_000,
        )
        const sub = runtimeOf(model.sessionId())
        expect(sub.kind === "hc", "subagent escaped its parent runtime: " + JSON.stringify(sub))
        expect(
          (await core.get(addressOf(sub.id!))).parent === inner.address,
          "subagent did not open beside its hc parent",
        )
        const outer = await herdr(socket, "pane.process_info", { pane_id: pane })
        expect((outer.process_info as { shell_pid?: number }).shell_pid !== undefined, "outer herdr shell died")
      } finally {
        model.stop()
        await w.stopDaemon()
        await restore()
        await core.stop()
      }
    },
  },
  {
    id: "S33",
    title:
      "herdr-core runtime: a Pi main agent started with --runtime hc runs `vibest run`, the subagent starts in hc as its child (no notes, outlives it), results and a send go both ways; the main terminal carries herdr.space=<project> and herdr.tab=<main session>, with readable project and task names",
    run: async (w) => {
      for (const bin of ["pi", "hc"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = delegatingModel("pi", { heldMs: 3_000 })
      w.ownRuntimes.add("hc")
      await w.stopDaemon()
      const piAgentDir = await piDir(w, "pi-hc", model.url)
      const env = `PI_CODING_AGENT_DIR=${piAgentDir}`
      const core = await isolatedCore(w, piAgentDir, "hc")
      const restore = await configureRuntime(w, "hc")
      try {
        const repo = await project(w, "hc")
        await w.ok(["--harness", "pi", "--runtime", "hc", "--headless", "--env", env], {
          cwd: repo,
          timeoutMs: 60_000,
          env: { CLAUDE_CONFIG_DIR: undefined },
        })
        let main = ""
        await until(
          "the main agent in vibest ls",
          async () => {
            main = (await w.json<Array<Entry>>(["ls"], { cwd: repo })).find((e) => e.agent === "main")?.id ?? ""
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
            const listed = await w.json<Array<Entry>>(["ls"], { cwd: repo }).catch(() => [] as Array<Entry>)
            const end = Date.now()
            for (const e of listed)
              samples.set(e.id, [...(samples.get(e.id) ?? []), { at, end, status: e.status, turnState: e.turnState }])
            await Bun.sleep(100)
          }
        })()
        await w.ok(["run", "pi", "--env", env, "--title", "Fix login bug", ask("zero")], {
          cwd: repo,
          timeoutMs: 60_000,
        })
        await reached("the main agent's turn on the first result", "done-zero")
        await reached("the main agent's turn on the result of the subagent it started", "done-one")
        await reached("the main agent's turn on the result after its vibest send", "done-two")
        await until(
          "the main agent idle after its last turn",
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
        expect(mainAt.kind === "hc", `the main agent runs in ${JSON.stringify(mainAt)}, not hc`)
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
          JSON.stringify((samples.get(id) ?? []).map((x) => `${x.at % 100_000} ${x.status}/${x.turnState}`))
        const mainSeen = samples.get(main) ?? []
        const mainWorking = mainSeen.findIndex((x) => x.status === "working")
        expect(
          mainWorking >= 0 && mainSeen.slice(mainWorking).some((x) => x.status === "idle"),
          `the main agent was not seen working, then idle: ${shown(main)}`,
        )
        const subSeen = samples.get(sub) ?? []
        for (const marker of ["one", "two"]) {
          const turn = model.answered.find((t) => t.marker === marker)
          expect(turn !== undefined, `the model never answered the subagent's ${marker} task`)
          const during = subSeen.filter((x) => x.at > turn!.from + 500 && x.end < turn!.to)
          expect(
            during.length > 0 && during.every((x) => x.status === "working"),
            `the subagent was not shown working while the model held its ${marker} answer (${turn!.from % 100_000}-${turn!.to % 100_000}): ${shown(sub)}`,
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
        await restore()
        await core.stop()
      }
    },
  },
  {
    id: "S34",
    title:
      "herdr-core runtime: `vibest --runtime hc` typed into a terminal of the user's own core starts the main agent in place, in that terminal on that core, and labels it for herdr-app",
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
        const typed = await core.hc(
          "send",
          "users-own",
          `cd ${repo} && vibest --harness pi --runtime hc --env PI_CODING_AGENT_DIR=${piAgentDir}`,
        )
        expect(typed.code === 0, `hc send: ${typed.stderr}`)
        let main = ""
        await until(
          "the main agent in vibest ls",
          async () => {
            main = (await w.json<Array<Entry>>(["ls"], { cwd: repo })).find((e) => e.agent === "main")?.id ?? ""
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
          `the main agent runs in ${JSON.stringify(at)}, not in ${users.address} on ${w.hcSocket}`,
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
]

export default checks
