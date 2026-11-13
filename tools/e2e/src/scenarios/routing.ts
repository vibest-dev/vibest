import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, claudeEnv, fakeAnthropic, heldModel } from "../fake-model.ts"
import { expect, herdr, readDb, replyOf, Skip, until, type World } from "../world.ts"
import { configurePlugins } from "../world/plugins.ts"
import { piShadow } from "../world/shadow.ts"
import { dropHerdrSession, project } from "./inbox.ts"

type Entry = {
  id: string
  agent: string
  harness: string
  provider: string | null
  model: string | null
  projectId: string
  address: { id: string }
  routing?: { decidedBy: Record<string, string> }
}
type Listed = { harness: string; binary: string; available: boolean }

const needs = (...bins: Array<string>) => {
  for (const bin of bins) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
}

const writePlugin = async (w: World, id: string, effect: string) => {
  const file = path.join(w.vibestHome, "plugins", `${id}.ts`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    `${file}.tmp`,
    `import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"
export default Plugin.define({ id: ${JSON.stringify(id)}, effect: (ctx) => ${effect} })
`,
  )
  await fs.rename(`${file}.tmp`, file)
  await until(
    `plugin ${id} active`,
    async () =>
      (await w.json<Array<{ id: string; status: string }>>(["plugins"])).some(
        (p) => p.id === id && p.status === "active",
      ),
    30_000,
  )
  return file
}

const withoutDefaultHarness = async (w: World) => {
  await configurePlugins(w, (plugins) => [...plugins, "-harness-default"])
  await until(
    "harness-default removed",
    async () => (await w.json<Array<{ id: string }>>(["plugins"])).every((p) => p.id !== "harness-default"),
    30_000,
  )
}

const withDefaultHarness = async (w: World) => {
  await configurePlugins(w, (plugins) => plugins.filter((p) => p !== "-harness-default"))
  await until(
    "harness-default back",
    async () => (await w.json<Array<{ id: string }>>(["plugins"])).some((p) => p.id === "harness-default"),
    30_000,
  )
}

const fakePi = async (w: World, name: string) => {
  const model = heldModel()
  model.release()
  const dir = await piShadow(
    path.join(w.root, `pi-${name}`),
    w.profile,
    { first: { baseUrl: model.url, models: ["m", "m2"] }, second: { baseUrl: model.url, models: ["m", "m2"] } },
    { provider: "first", model: "m" },
  )
  return { model, dir }
}

const sessions = (w: World, cwd = w.repository) =>
  w.json<{ sessions: Array<Entry> }>(["ls", "--all"], { cwd }).then((l) => l.sessions)

const entry = async (w: World, id: string) => (await sessions(w)).find((e) => e.id === id)

const runId = async (w: World, args: ReadonlyArray<string>) => {
  const printed = JSON.parse(await w.okViaEntry(["run", ...args], { timeoutMs: 90_000 })) as { id: string }
  expect(Object.keys(printed).join() === "id", `vibest run prints only the id: ${JSON.stringify(printed)}`)
  return printed.id
}

const resultOf = (w: World, id: string, marker: string) =>
  until(`the answer of ${marker}`, async () => (await replyOf(w, id)).includes(`done-${marker}`), 90_000)

const entrySession = async (w: World) => {
  let entry: Entry | undefined
  await until(
    "the entry session in vibest ls",
    async () => {
      entry = (await sessions(w)).find((e) => e.agent === "coordinator")
      return entry !== undefined
    },
    60_000,
  )
  return entry!
}

const factLines = (file: string): Promise<Array<string>> =>
  fs.readFile(file, "utf8").then(
    (text) => text.split("\n").filter(Boolean),
    () => [],
  )

const observer = (file: string, types: string) => `import { Plugin } from "@vibest/plugin/effect"
import { Effect, Stream } from "effect"
import fs from "node:fs"
export default Plugin.define({
  id: "observer",
  effect: (ctx) =>
    ctx.event.subscribe(${types}).pipe(
      Stream.runForEach((fact) => Effect.sync(() => fs.appendFileSync(${JSON.stringify(file)}, \`\${fact.type} \${fact.sessionId ?? "-"}\\n\`))),
      Effect.forkScoped,
      Effect.asVoid,
    ),
})
`

const promised = (facts: string, cleanup: string) => `import fs from "node:fs"
import { Plugin } from "@vibest/plugin"
export default Plugin.define({
  id: "promised",
  setup: async (ctx) => {
    await ctx.agent.hook("start.before", async (e) => (e.prompt.includes("done-promised") ? { harness: "pi" } : undefined))
    void (async () => {
      for await (const fact of ctx.event.subscribe({ types: ["execution.ended"] }))
        fs.appendFileSync(${JSON.stringify(facts)}, \`\${fact.type} \${fact.sessionId}\\n\`)
    })()
    return () => fs.appendFileSync(${JSON.stringify(cleanup)}, "cleanup\\n")
  },
})
`

const checks: ReadonlyArray<Check> = [
  {
    id: "G5",
    title:
      "a routing plugin's agent.start.before picks the harness: with it the run starts Pi, ls names the plugin as the harness's decider, and its answer arrives",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "route")
      try {
        await w.daemon({ env: { PI_CODING_AGENT_DIR: dir } })
        await w.entry({ processEnv: { PI_CODING_AGENT_DIR: dir } })
        await writePlugin(
          w,
          "router",
          `ctx.agent.hook("start.before", (e) => Effect.succeed(e.prompt.includes("done-routed") ? { harness: "pi" } : undefined))`,
        )
        const id = await runId(w, ["--", ask("routed")])
        const e = await entry(w, id)
        expect(e?.harness === "pi" && e.routing?.decidedBy.harness === "router", `routed session: ${JSON.stringify(e)}`)
        await resultOf(w, id, "routed")
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "G6",
    title:
      "a user plugin's harness.transform points Pi at another binary: `vibest harness list` shows it, the next `vibest run pi` starts it, and removing the plugin restores the builtin `pi`",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "wrap")
      const bin = path.join(w.root, "bin")
      const marker = path.join(w.root, "wrapper-ran")
      try {
        await fs.mkdir(bin)
        await fs.writeFile(path.join(bin, "pi-wrapped"), `#!/bin/sh\necho ran >> '${marker}'\nexec pi "$@"\n`, {
          mode: 0o755,
        })
        const daemonEnv = { PI_CODING_AGENT_DIR: dir, PATH: `${bin}:${w.env().PATH}` }
        await w.daemon({ env: daemonEnv })
        await w.entry({ processEnv: daemonEnv })
        const piBinary = async () =>
          (await w.json<Array<Listed>>(["harness", "list"], { timeoutMs: 60_000 })).find((h) => h.harness === "pi")
        const file = await writePlugin(
          w,
          "wrap-pi",
          `ctx.harness.transform((editor) => editor.update("pi", (d) => { d.binary = "pi-wrapped" }))`,
        )
        await until("harness list shows pi-wrapped", async () => (await piBinary())?.binary === "pi-wrapped", 30_000)
        expect((await piBinary())?.available === true, `pi-wrapped not startable: ${JSON.stringify(await piBinary())}`)
        const id = await runId(w, ["pi", "--", ask("wrapped")])
        await resultOf(w, id, "wrapped")
        expect(await Bun.file(marker).exists(), "the run did not start pi-wrapped")
        await fs.rm(file)
        await until("harness list shows pi again", async () => (await piBinary())?.binary === "pi", 30_000)
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "H5",
    title:
      "`vibest run` without a harness takes the harness, provider and model of the entry session that runs it; a named harness drops provider and model",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "inherit")
      try {
        await w.daemon({ env: { PI_CODING_AGENT_DIR: dir } })
        await w.startEntry({
          harness: "pi",
          extra: ["--provider", "second", "--model", "m2"],
          env: { PI_CODING_AGENT_DIR: dir },
          timeoutMs: 90_000,
        })
        const entryRow = await entrySession(w)
        expect(
          entryRow.harness === "pi" && entryRow.provider === "second" && entryRow.model === "m2",
          `entry session: ${JSON.stringify(entryRow)}`,
        )
        const inherited = await entry(w, await runId(w, ["--", ask("frommain")]))
        expect(
          inherited?.harness === "pi" && inherited.provider === "second" && inherited.model === "m2",
          `frommain: ${JSON.stringify(inherited)}`,
        )
        const named = await entry(w, await runId(w, ["pi", "--", ask("named")]))
        expect(
          named?.harness === "pi" && named.provider === null && named.model === null,
          `named harness: ${JSON.stringify(named)}`,
        )
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "H6",
    title:
      "`vibest` without `--harness`: a project's first start with the default deliberately removed (`-harness-default`) fails asking for it; with the default back, a Pi entry session that exits is restarted on Pi (the default does not override reuse)",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "reuse")
      try {
        await w.daemon({ env: { PI_CODING_AGENT_DIR: dir } })
        await withoutDefaultHarness(w)
        const first = await w.vibest(["--headless"], { timeoutMs: 60_000 })
        expect(
          first.code !== 0 && /no harness to inherit: pass --harness/.test(first.stderr + first.stdout),
          `first start without --harness: ${first.code} ${first.stderr}${first.stdout}`,
        )
        await withDefaultHarness(w)
        await w.startEntry({ harness: "pi", env: { PI_CODING_AGENT_DIR: dir }, timeoutMs: 90_000 })
        const entryRow = await entrySession(w)
        const processes = () => {
          const db = readDb(path.join(w.vibestHome, "vibest.db"))
          try {
            return db
              .query<{ harness: string; readyAt: number | null; endedAt: number | null }, [string]>(
                "SELECT harness, ready_at AS readyAt, ended_at AS endedAt FROM process WHERE session_id = ? ORDER BY id",
              )
              .all(entryRow.id)
          } finally {
            db.close()
          }
        }
        await until("the entry session ready", () => processes().some((p) => p.readyAt !== null), 60_000)
        const socket = path.join(w.home, ".config", "herdr", "sessions", w.herdrSession, "herdr.sock")
        await herdr(socket, "pane.close", { pane_id: entryRow.address.id.split("/").pop() })
        await until("the entry session's exit recorded", () => processes().some((p) => p.endedAt !== null), 30_000)
        const again = await w.vibest(["--headless"], { env: { PI_CODING_AGENT_DIR: dir }, timeoutMs: 60_000 })
        expect(again.code === 0, `restart without --harness: ${again.code} ${again.stderr}${again.stdout}`)
        await until("a second start", () => processes().length === 2, 30_000)
        const started = processes()[1]!
        expect(started.harness === "pi", `restarted with ${JSON.stringify(started)}`)
        await until("the restarted Pi ready", () => processes()[1]?.readyAt != null, 60_000)
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "H7",
    title:
      "the default harness is Claude: a project's first bare `vibest` without --harness starts its entry session on Claude; a user plugin that picks Pi wins over the default; when Claude cannot start it fails `no harness to inherit`",
    run: async (w) => {
      needs("claude", "pi", "herdr")
      const anthropic = fakeAnthropic(() => "ok")
      const { model, dir } = await fakePi(w, "dflt")
      const session = `${w.herdrSession}-dflt`
      const startedIn = async (name: string, env: Record<string, string>) => {
        const repo = await project(w, name)
        await w.startEntry({ session, cwd: repo, env, timeoutMs: 120_000 })
        let main: Entry | undefined
        await until(
          `the entry session of ${name}`,
          async () => (main = (await sessions(w, repo)).find((e) => e.agent === "coordinator")) !== undefined,
          60_000,
        )
        return main!
      }
      try {
        await w.daemon()
        const claude = await startedIn("dflt-claude", await claudeEnv(w, "dflt", anthropic.url, w.config.claude))
        expect(claude.harness === "claude", `first start without --harness: ${JSON.stringify(claude)}`)

        const router = await writePlugin(
          w,
          "router",
          `ctx.agent.hook("start.before", () => Effect.succeed({ harness: "pi" }))`,
        )
        const pi = await startedIn("dflt-pi", { PI_CODING_AGENT_DIR: dir })
        expect(pi.harness === "pi", `a plugin picking Pi: ${JSON.stringify(pi)}`)
        await fs.rm(router)
        await until("router gone", async () =>
          (await w.json<Array<{ id: string }>>(["plugins"])).every((p) => p.id !== "router"),
        )

        await writePlugin(
          w,
          "no-claude",
          `ctx.harness.transform((editor) => editor.update("claude", (d) => { d.binary = "claude-not-installed" }))`,
        )
        await until(
          "claude not startable",
          async () =>
            (await w.json<Array<Listed>>(["harness", "list"], { timeoutMs: 60_000 })).some(
              (h) => h.harness === "claude" && !h.available,
            ),
          30_000,
        )
        const repo = await project(w, "dflt-none")
        const refused = await w.vibest(["--headless"], { cwd: repo, timeoutMs: 60_000 })
        expect(
          refused.code !== 0 && /no harness to inherit/.test(refused.stderr + refused.stdout),
          `claude unavailable: ${refused.code} ${refused.stderr}${refused.stdout}`,
        )
      } finally {
        model.stop()
        anthropic.stop()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "G14",
    title:
      "`-<id>` in vibest.json removes a builtin plugin by exact id and `-*` does not; a first start while slow user plugins are still importing is refused instead of running without them; deleting the line brings the builtin back without restarting vibestd",
    run: async (w) => {
      needs("herdr")
      const slow = [1, 2, 3, 4, 5, 6, 7].map((n) => path.join(w.vibestHome, "slow", `slow-${n}`))
      for (const [n, folder] of slow.entries()) {
        await fs.mkdir(folder, { recursive: true })
        await fs.writeFile(
          path.join(folder, "index.ts"),
          `import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"
await new Promise((resolve) => setTimeout(resolve, 4800))
export default Plugin.define({ id: "slow-${n + 1}", effect: () => Effect.void })
`,
        )
      }
      await configurePlugins(w, () => ["-*", "-harness-default", ...slow])
      await w.daemon()
      const pid = await w.daemonPid()
      const started = await w.vibest(["--headless"], { timeoutMs: 60_000 })
      const out = started.stderr + started.stdout
      expect(
        started.code !== 0 &&
          /PluginsNotActive/.test(out) &&
          !/no harness to inherit/.test(out) &&
          ["slow-5", "slow-6", "slow-7"].every((name) => out.includes(name)),
        `first start while plugins import: ${started.code} ${out}`,
      )
      const active = async () =>
        (await w.json<Array<{ id: string; status: string }>>(["plugins"], { timeoutMs: 60_000 })).filter(
          (p) => p.status === "active",
        )
      await until(
        "the slow plugins active",
        async () => (await active()).filter((p) => p.id.startsWith("slow-")).length === 7,
        60_000,
      )
      const ids = (await active()).map((p) => p.id)
      expect(
        !ids.includes("harness-default") && ids.includes("runtime-choice"),
        `after -* and -harness-default: ${ids}`,
      )
      await configurePlugins(w, () => ["-*", ...slow])
      await until("harness-default back", async () => (await active()).some((p) => p.id === "harness-default"), 60_000)
      expect((await w.daemonPid()) === pid, "vibestd restarted")
    },
  },
  {
    id: "G12",
    covers: ["G2"],
    title:
      "a plugin's ctx.event.subscribe sees the ledger facts of a real Pi subagent in order (session.created, process.started, execution.started, execution.ended) and no live events; a new revision of the plugin gets the next agent's facts and the old one stops",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "observe")
      const first = path.join(w.root, "facts-first")
      const second = path.join(w.root, "facts-second")
      const file = path.join(w.vibestHome, "plugins", "observer.ts")
      const save = async (text: string) => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(`${file}.tmp`, text)
        await fs.rename(`${file}.tmp`, file)
      }
      const ordered = ["session.created", "process.started", "execution.started", "execution.ended"]
      const of = (lines: ReadonlyArray<string>, id: string) =>
        lines.filter((line) => line.endsWith(` ${id}`)).map((line) => line.split(" ")[0]!)
      const inOrder = (types: ReadonlyArray<string>) => {
        let at = 0
        for (const type of types) if (type === ordered[at]) at++
        return at === ordered.length
      }
      try {
        await w.daemon({ env: { PI_CODING_AGENT_DIR: dir } })
        await w.entry({ processEnv: { PI_CODING_AGENT_DIR: dir } })
        await save(observer(first, JSON.stringify({ types: ordered })))
        await until("the observer active", async () =>
          (await w.json<Array<{ id: string; status: string }>>(["plugins"])).some(
            (p) => p.id === "observer" && p.status === "active",
          ),
        )
        const one = await runId(w, ["pi", "--", ask("observed")])
        await resultOf(w, one, "observed")
        await until("the first agent's facts in order", async () => inOrder(of(await factLines(first), one)), 60_000)
        const seen = of(await factLines(first), one)
        expect(
          seen.every((type) => ordered.includes(type)),
          `the observer got facts it did not ask for: ${JSON.stringify(seen)}`,
        )
        const revision = (await w.json<Array<{ id: string; revision: string }>>(["plugins"])).find(
          (p) => p.id === "observer",
        )!.revision
        await save(observer(second, "{}"))
        await until("the new revision active", async () =>
          (await w.json<Array<{ id: string; status: string; revision: string }>>(["plugins"])).some(
            (p) => p.id === "observer" && p.status === "active" && p.revision !== revision,
          ),
        )
        const before = (await factLines(first)).length
        const two = await runId(w, ["pi", "--", ask("observedagain")])
        await resultOf(w, two, "observedagain")
        await until("the second agent's facts in order", async () => inOrder(of(await factLines(second), two)), 60_000)
        const all = await factLines(second)
        expect(
          !all.some((line) => /^(terminal\.|runtime\.reset|session\.changed|project\.changed|drain\.)/.test(line)),
          `signals reached the plugin: ${JSON.stringify(all)}`,
        )
        expect(
          (await factLines(first)).length === before,
          `the replaced revision still wrote: ${JSON.stringify((await factLines(first)).slice(before))}`,
        )
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "G13",
    title:
      "a plugin written as { id, setup } with Promises routes `vibest run -- <task>` to a real Pi, ls names it as the decider, its event.subscribe iterator gets the agent's execution.ended, and deleting the file runs its cleanup",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "promised")
      const facts = path.join(w.root, "promised-facts")
      const cleanup = path.join(w.root, "promised-cleanup")
      const file = path.join(w.vibestHome, "plugins", "promised.ts")
      try {
        await w.daemon({ env: { PI_CODING_AGENT_DIR: dir } })
        await w.entry({ processEnv: { PI_CODING_AGENT_DIR: dir } })
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(`${file}.tmp`, promised(facts, cleanup))
        await fs.rename(`${file}.tmp`, file)
        await until("the setup plugin active", async () =>
          (await w.json<Array<{ id: string; status: string }>>(["plugins"])).some(
            (p) => p.id === "promised" && p.status === "active",
          ),
        )
        const id = await runId(w, ["--", ask("promised")])
        const e = await entry(w, id)
        expect(
          e?.harness === "pi" && e.routing?.decidedBy.harness === "promised",
          `routed session: ${JSON.stringify(e)}`,
        )
        await resultOf(w, id, "promised")
        await until(
          "the agent's execution.ended",
          async () => (await factLines(facts)).includes(`execution.ended ${id}`),
          60_000,
        )
        expect((await factLines(cleanup)).length === 0, "cleanup ran while the plugin was loaded")
        await fs.rm(file)
        await until("the plugin unloaded", async () =>
          (await w.json<Array<{ id: string }>>(["plugins"])).every((p) => p.id !== "promised"),
        )
        await until("its cleanup ran", async () => (await factLines(cleanup)).join() === "cleanup", 30_000)
      } finally {
        model.stop()
      }
    },
  },
  {
    id: "G15",
    title:
      "three user plugins whose setup each sleeps 4 s are together over the activation wait: vibest run right after they are written is refused with PluginsNotActive and the plugins still loading, and the same run succeeds once they are active, with the routing plugin as the decider",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "gate")
      const ids = ["gate-a", "gate-b", "gate-router"]
      const install = async (id: string, effect: string) => {
        const file = path.join(w.vibestHome, "plugins", `${id}.ts`)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(
          `${file}.tmp`,
          `import fs from "node:fs"
import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
export default Plugin.define({ id: ${JSON.stringify(id)}, effect: (ctx) => ${effect} })
`,
        )
        await fs.rename(`${file}.tmp`, file)
      }
      try {
        await w.daemon({ env: { PI_CODING_AGENT_DIR: dir } })
        await w.entry({ processEnv: { PI_CODING_AGENT_DIR: dir } })
        const session = await w.entryOf(w.repository)
        const mine = (await sessions(w)).find((row) => row.id === session)
        expect(session !== undefined && mine !== undefined, "the entry session")
        const marker = path.join(w.root, "gate-a-started")
        const sleep = `Effect.sleep("4 seconds")`
        await install(
          "gate-a",
          `Effect.sync(() => fs.writeFileSync(${JSON.stringify(marker)}, "in")).pipe(Effect.andThen(${sleep}))`,
        )
        await install("gate-b", sleep)
        await install(
          "gate-router",
          `${sleep}.pipe(Effect.andThen(ctx.agent.hook("start.before", (e) => Effect.succeed(e.prompt.includes("done-gated") ? { harness: "pi" } : undefined))))`,
        )
        await until(
          "the first setup",
          () =>
            fs.access(marker).then(
              () => true,
              () => false,
            ),
          30_000,
        )
        const refused = await w.vibest(["run", "--", ask("gated")], {
          env: {
            VIBEST_SESSION_ID: session,
            VIBEST_PROJECT_ID: mine?.projectId,
            PI_CODING_AGENT_DIR: dir,
          },
          timeoutMs: 30_000,
        })
        const out = refused.stderr + refused.stdout
        const named = ids.filter((id) => out.includes(id))
        expect(
          refused.code !== 0 && /PluginsNotActive/.test(out) && named.length > 0,
          `run while plugins set up: ${refused.code} ${out}`,
        )
        await until(
          "the slow plugins active",
          async () => {
            const active = new Set(
              (await w.json<Array<{ id: string; status: string }>>(["plugins"], { timeoutMs: 60_000 }))
                .filter((p) => p.status === "active")
                .map((p) => p.id),
            )
            return ids.every((id) => active.has(id))
          },
          30_000,
        )
        const id = await runId(w, ["--", ask("gated")])
        const started = await entry(w, id)
        expect(
          started?.harness === "pi" && started.routing?.decidedBy.harness === "gate-router",
          `routed once active: ${JSON.stringify(started)}`,
        )
        await resultOf(w, id, "gated")
      } finally {
        model.stop()
      }
    },
  },
]

export default checks
