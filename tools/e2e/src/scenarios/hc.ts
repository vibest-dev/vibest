import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { expect, row, SESSIONS, Skip, until, type World } from "../world.ts"
import { ask, delegatingModel, piDir, project } from "./inbox.ts"

type Entry = { id: string; agent: string }
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
  const dirs = { state: path.join(w.root, `${tag}-state`), config: path.join(w.root, `${tag}-config`) }
  const zdot = path.join(w.root, `zdotdir-${tag}`)
  for (const dir of [...Object.values(dirs), zdot]) await fs.mkdir(dir, { recursive: true })
  const env = {
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
      "herdr-core runtime: a Pi main agent started with --runtime hc runs `vibest run`, the subagent starts in hc as its child (no notes, outlives it), results and a send go both ways; the main terminal carries herdr.space=<project> and herdr.tab=<main session>",
    run: async (w) => {
      for (const bin of ["pi", "hc"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const model = delegatingModel("pi")
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
        await w.ok(["run", "pi", "--env", env, ask("zero")], { cwd: repo, timeoutMs: 60_000 })
        await reached("the main agent's turn on the first result", "done-zero")
        await reached("the main agent's turn on the result of the subagent it started", "done-one")
        await reached("the main agent's turn on the result after its vibest send", "done-two")

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
        expect(
          subTerminal.parent === mainTerminal.address &&
            subTerminal.notify === false &&
            subTerminal.labels["vibest.session"] === sub &&
            subTerminal.labels["vibest.project"] === projectId &&
            subTerminal.labels["herdr.space"] === undefined,
          `the subagent's terminal: ${JSON.stringify(subTerminal)}; main ${mainTerminal.address}`,
        )
        const all = await Promise.all((await core.terminals()).map((t) => core.get(t.address)))
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
            const labels = (await core.get("users-own")).labels
            return (
              labels["vibest.runtime"] === "hc" && labels["herdr.space"] === projectId && labels["herdr.tab"] === main
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
