import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, heldModel } from "../fake-model.ts"
import { replyOf, expect, herdr, readDb, Skip, until, type World } from "../world.ts"
import { piShadow } from "../world/shadow.ts"

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
    `import { Plugin } from "@vibest/plugin"
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

const runId = async (w: World, args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const printed = JSON.parse(await w.ok(["run", ...args], { env, timeoutMs: 90_000 })) as { id: string }
  expect(Object.keys(printed).join() === "id", `vibest run prints only the id: ${JSON.stringify(printed)}`)
  return printed.id
}

const resultOf = (w: World, id: string, marker: string) =>
  until(`the answer of ${marker}`, async () => (await replyOf(w, id)).includes(`done-${marker}`), 90_000)

const mainSession = async (w: World) => {
  let main: Entry | undefined
  await until(
    "the main agent in vibest ls",
    async () => {
      main = (await sessions(w)).find((e) => e.agent === "main")
      return main !== undefined
    },
    60_000,
  )
  return main!
}

const factLines = (file: string): Promise<Array<string>> =>
  fs.readFile(file, "utf8").then(
    (text) => text.split("\n").filter(Boolean),
    () => [],
  )

const observer = (file: string, types: string) => `import { Plugin } from "@vibest/plugin"
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
      "a routing plugin's agent.start.before picks the harness: without it `vibest run -- <task>` with nothing to inherit fails; with it the run starts Pi, ls names the plugin as the harness's decider, and its answer arrives",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "route")
      try {
        await w.daemon({ env: { PI_CODING_AGENT_DIR: dir } })
        const before = await w.vibest(["run", "--", ask("unrouted")], { timeoutMs: 60_000 })
        expect(
          before.code !== 0 && before.stderr.includes("no harness to inherit"),
          `run without a router: ${before.code} ${before.stderr}`,
        )
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
        await w.daemon({ env: { PI_CODING_AGENT_DIR: dir, PATH: `${bin}:${w.env().PATH}` } })
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
      "`vibest run` without a harness takes the main agent's harness, provider and model, from the main agent and from a plain terminal; a named harness drops provider and model; with nothing to inherit it fails `no harness to inherit`",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "inherit")
      try {
        await w.daemon({ env: { PI_CODING_AGENT_DIR: dir } })
        const nothing = await w.vibest(["run", "--", ask("nothing")], { timeoutMs: 60_000 })
        expect(
          nothing.code !== 0 && nothing.stderr.includes("no harness to inherit"),
          `run with nothing to inherit: ${nothing.code} ${nothing.stderr}`,
        )
        await w.startMain({
          harness: "pi",
          extra: ["--provider", "second", "--model", "m2"],
          env: { PI_CODING_AGENT_DIR: dir },
          timeoutMs: 90_000,
        })
        const main = await mainSession(w)
        expect(
          main.harness === "pi" && main.provider === "second" && main.model === "m2",
          `main agent: ${JSON.stringify(main)}`,
        )
        const inherits = async (label: string, env: Record<string, string>) => {
          const e = await entry(w, await runId(w, ["--", ask(label)], env))
          expect(e?.harness === "pi" && e.provider === "second" && e.model === "m2", `${label}: ${JSON.stringify(e)}`)
        }
        await inherits("plain", {})
        await inherits("frommain", {
          VIBEST_AGENT: "coordinator",
          VIBEST_SESSION_ID: main.id,
          VIBEST_PROJECT_ID: main.projectId,
        })
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
      "`vibest` without `--harness`: a project's first start fails asking for it; after the Pi main agent exits, it restarts that harness",
    run: async (w) => {
      needs("pi", "herdr")
      const { model, dir } = await fakePi(w, "reuse")
      try {
        await w.daemon({ env: { PI_CODING_AGENT_DIR: dir } })
        const first = await w.vibest(["--headless"], { timeoutMs: 60_000 })
        expect(
          first.code !== 0 && /no harness to inherit: pass --harness/.test(first.stderr + first.stdout),
          `first start without --harness: ${first.code} ${first.stderr}${first.stdout}`,
        )
        await w.startMain({ harness: "pi", env: { PI_CODING_AGENT_DIR: dir }, timeoutMs: 90_000 })
        const main = await mainSession(w)
        const processes = () => {
          const db = readDb(path.join(w.vibestHome, "vibest.db"))
          try {
            return db
              .query<{ harness: string; readyAt: number | null; endedAt: number | null }, [string]>(
                "SELECT harness, ready_at AS readyAt, ended_at AS endedAt FROM process WHERE session_id = ? ORDER BY id",
              )
              .all(main.id)
          } finally {
            db.close()
          }
        }
        await until("the main agent ready", () => processes().some((p) => p.readyAt !== null), 60_000)
        const socket = path.join(w.home, ".config", "herdr", "sessions", w.herdrSession, "herdr.sock")
        await herdr(socket, "pane.close", { pane_id: main.address.id.split("/").pop() })
        await until("the main agent's exit recorded", () => processes().some((p) => p.endedAt !== null), 30_000)
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
    id: "G12",
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
        expect(!all.some((line) => line.startsWith("live.")), `live events reached the plugin: ${JSON.stringify(all)}`)
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
]

export default checks
