import fs from "node:fs/promises"
import path from "node:path"
import url from "node:url"

import type { Check } from "../check.ts"
import { expect, until, type World } from "../world.ts"

type Info = {
  id: string
  source: string
  status: "active" | "failed"
  error?: string
  calls: number
  refused: number
  crashed: number
}

const list = (w: World) => w.json<Array<Info>>(["plugins"])

const plugin = (id: string, hook = "() => Effect.void") => `import { AgentRefused, Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"
export default Plugin.define({ id: ${JSON.stringify(id)}, effect: (ctx) => ctx.agent.hook("start.before", ${hook}) })
`

const transformThrows = (id: string, counter: string) => `import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"
import fs from "node:fs"
export default Plugin.define({
  id: ${JSON.stringify(id)},
  effect: (ctx) =>
    Effect.sync(() => fs.appendFileSync(${JSON.stringify(counter)}, "setup\\n")).pipe(
      Effect.andThen(ctx.harness.transform(() => { throw new Error("e2e transform throw") })),
    ),
})
`

const lines = (file: string) =>
  fs.readFile(file, "utf8").then(
    (text) => text.split("\n").filter(Boolean).length,
    () => 0,
  )

const counting = (id: string, file: string) => `import fs from "node:fs"
import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"
export default Plugin.define({
  id: ${JSON.stringify(id)},
  effect: (ctx) => Effect.sync(() => fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify(ctx.options) + "\\n")),
})
`

const setups = (file: string) =>
  fs.readFile(file, "utf8").then(
    (text) => text.split("\n").filter(Boolean),
    () => [],
  )

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(`${file}.tmp`, text)
  await fs.rename(`${file}.tmp`, file)
}

const failingTeardown = (id: string) => `import { Plugin } from "@vibest/plugin/effect"
import { Effect } from "effect"
export default Plugin.define({
  id: ${JSON.stringify(id)},
  effect: () => Effect.addFinalizer(() => Effect.die(new Error("e2e teardown boom"))),
})
`

const checks: ReadonlyArray<Check> = [
  {
    id: "G2",
    title:
      "a plugin whose teardown fails is logged as an error with its id and cause, and its edited revision still runs",
    run: async (w) => {
      const file = path.join(w.vibestHome, "plugins", "unclean.ts")
      await write(file, failingTeardown("unclean"))
      await until("the first revision active", async () =>
        (await list(w)).some((p) => p.id === "unclean" && p.status === "active"),
      )
      await write(file, plugin("unclean-v2"))
      await until("the edited revision active", async () =>
        (await list(w)).some((p) => p.id === "unclean-v2" && p.status === "active"),
      )
      const log = await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8")
      expect(
        /level=ERROR[^\n]*failed to clean up plugin[^\n]*plugin\.id=unclean[^\n]*e2e teardown boom/.test(log),
        `the failed teardown was not logged: ${log.slice(-2000)}`,
      )
      await fs.rm(file)
    },
  },
  {
    id: "G1",
    title:
      "plugins lists one from VIBEST_HOME/plugins, one from vibest.json, and one named by a file:// URL with an escaped space",
    run: async (w) => {
      await write(path.join(w.vibestHome, "plugins", "home.ts"), plugin("home"))
      const configured = path.join(w.root, "configured", "index.ts")
      await write(configured, plugin("configured"))
      const spaced = path.join(w.root, "with space", "index.ts")
      await write(spaced, plugin("spaced"))
      const solo = path.join(w.root, "solo.ts")
      await write(solo, plugin("solo"))
      await write(
        path.join(w.vibestHome, "vibest.json"),
        JSON.stringify({
          plugins: [path.dirname(configured), url.pathToFileURL(path.dirname(spaced)).href, solo],
        }),
      )
      await until("all three plugins active", async () => {
        const all = await list(w)
        return ["home", "configured", "spaced"].every((id) => all.some((p) => p.id === id && p.status === "active"))
      })
      await until("the single-file entry refused", async () =>
        (await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8")).includes(
          `vibest.json: plugin path must be a directory: ${solo}`,
        ),
      )
      expect(!(await list(w)).some((p) => p.id === "solo"), "a single file named in vibest.json was loaded")
    },
  },
  {
    id: "G3",
    title: "a plugin that fails to load is reported; the others stay active",
    run: async (w) => {
      const steady = path.join(w.vibestHome, "plugins", "steady.ts")
      await write(steady, plugin("steady"))
      await until("the steady plugin loaded", async () =>
        (await list(w)).some((p) => p.id === "steady" && p.status === "active"),
      )
      await write(path.join(w.vibestHome, "plugins", "broken.ts"), "export default 42\n")
      await write(
        path.join(w.vibestHome, "plugins", "a-throw.ts"),
        `import { Plugin } from "@vibest/plugin/effect"
export default Plugin.define({ id: "a-throw", effect: () => { throw new Error("e2e setup throw") } })
`,
      )
      await until("the failures reported", async () => {
        const all = await list(w)
        return (
          all.some((p) => p.status === "failed" && p.source.endsWith("broken.ts")) &&
          all.some((p) => p.id === "a-throw" && p.status === "failed" && p.error?.includes("e2e setup throw")) &&
          all.some((p) => p.id === "steady" && p.status === "active")
        )
      })
      await fs.rm(path.join(w.vibestHome, "plugins", "broken.ts"))
      await fs.rm(path.join(w.vibestHome, "plugins", "a-throw.ts"))
      await fs.rm(steady)
    },
  },
  {
    id: "G4",
    title: "a refusing agent.start.before blocks run with its reason, before any worktree",
    entry: true,
    run: async (w) => {
      const sessions = () => w.json<{ sessions: Array<unknown> }>(["ls", "--all"]).then((l) => l.sessions.length)
      const sessionsBefore = await sessions()
      await write(
        path.join(w.vibestHome, "plugins", "refuse.ts"),
        plugin("refuse", `() => Effect.fail(new AgentRefused({ reason: "e2e says no" }))`),
      )
      await until("the refusing plugin active", async () =>
        (await list(w)).some((p) => p.id === "refuse" && p.status === "active"),
      )
      const worktrees = path.join(w.vibestHome, "worktrees")
      const before = await fs.readdir(worktrees).catch(() => [])
      const r = await w.viaEntry(["run", "pi", "--session", w.herdrSession, "--", "do nothing"], { timeoutMs: 60_000 })
      expect(r.code !== 0, `run exited 0: ${r.stdout}`)
      expect(r.stderr.includes("e2e says no"), `reason not shown: ${r.stderr}`)
      expect((await fs.readdir(worktrees).catch(() => [])).length === before.length, "a worktree was created")
      expect((await sessions()) === sessionsBefore, "a session row was written")
      expect(
        (await list(w)).some((p) => p.id === "refuse" && p.refused === 1),
        "the refusal was not counted",
      )
      await fs.rm(path.join(w.vibestHome, "plugins", "refuse.ts"))
      await write(
        path.join(w.vibestHome, "plugins", "throw.ts"),
        plugin("throw", `() => { throw new Error("e2e hook throw") }`),
      )
      await until("the throwing plugin active", async () =>
        (await list(w)).some((p) => p.id === "throw" && p.status === "active"),
      )
      const thrown = await w.viaEntry(["run", "pi", "--session", w.herdrSession, "--", "do nothing"], {
        timeoutMs: 60_000,
      })
      expect(thrown.code !== 0, `run exited 0: ${thrown.stdout}`)
      expect(thrown.stderr.includes("plugin throw crashed: e2e hook throw"), `crash not shown: ${thrown.stderr}`)
      expect((await fs.readdir(worktrees).catch(() => [])).length === before.length, "a worktree was created")
      expect(
        (await list(w)).some((p) => p.id === "throw" && p.crashed === 1),
        "the crash was not counted",
      )
      await fs.rm(path.join(w.vibestHome, "plugins", "throw.ts"))
    },
  },
  {
    id: "G11",
    title: "a plugin disabled by a failing transform is not set up again until it changes",
    run: async (w) => {
      const first = path.join(w.vibestHome, "plugins", "a.ts")
      const second = path.join(w.vibestHome, "plugins", "b.ts")
      const counter = path.join(w.root, "b-setups")
      await write(first, plugin("a"))
      await write(second, transformThrows("b", counter))
      await until("b disabled by its transform", async () =>
        (await list(w)).some((p) => p.id === "b" && p.status === "failed" && p.error?.includes("e2e transform throw")),
      )
      expect((await lines(counter)) === 1, `b set up ${await lines(counter)} times`)
      await write(first, plugin("a-v2"))
      await until("a reloaded", async () => (await list(w)).some((p) => p.id === "a-v2" && p.status === "active"))
      expect((await lines(counter)) === 1, `b set up again after a changed: ${await lines(counter)} times`)
      expect(
        (await list(w)).some((p) => p.id === "b" && p.status === "failed"),
        "b no longer listed as failed",
      )
      await write(second, transformThrows("b", counter).replace("e2e transform throw", "e2e transform throw again"))
      await until("b retried after it changed", async () => (await lines(counter)) === 2)
      await fs.rm(first)
      await fs.rm(second)
    },
  },
  {
    id: "G8",
    title: "a plugin edited into one that fails to import keeps running its last revision; nothing is set up again",
    run: async (w) => {
      const keep = path.join(w.root, "keep.log")
      const after = path.join(w.root, "after.log")
      const source = path.join(w.vibestHome, "plugins", "a-keep.ts")
      await write(source, counting("keep", keep))
      await write(path.join(w.vibestHome, "plugins", "b-after.ts"), counting("after", after))
      await until("both plugins active", async () => {
        const all = await list(w)
        return ["keep", "after"].every((id) => all.some((p) => p.id === id && p.status === "active"))
      })
      await write(source, `throw new Error("broken on purpose")\n`)
      await until("the failed revision reported beside the running one", async () =>
        (await list(w)).some(
          (p) => p.id === "keep" && p.status === "active" && (p.error ?? "").includes("broken on purpose"),
        ),
      )
      const all = await list(w)
      expect(
        all.some((p) => p.id === "after" && p.status === "active"),
        `after is not active: ${JSON.stringify(all)}`,
      )
      expect((await lines(keep)) === 1, `keep was set up again: ${await lines(keep)} setups`)
      expect((await lines(after)) === 1, `after was set up again: ${await lines(after)} setups`)
    },
  },
  {
    id: "G9",
    title: "a plugin folder found in plugins and named in vibest.json is one plugin, with the configured options",
    run: async (w) => {
      const seen = path.join(w.root, "foo.log")
      await write(path.join(w.vibestHome, "plugins", "foo", "index.ts"), counting("foo", seen))
      await write(
        path.join(w.vibestHome, "vibest.json"),
        JSON.stringify({ plugins: [{ package: "./plugins/foo", options: { tag: "e2e" } }] }),
      )
      await until("foo active with the configured options", async () => {
        const active = (await list(w)).some((p) => p.id === "foo" && p.status === "active")
        return active && (await setups(seen)).at(-1) === JSON.stringify({ tag: "e2e" })
      })
      const foo = (await list(w)).filter((p) => p.source.includes(`${path.sep}foo${path.sep}`))
      expect(foo.length === 1, `foo is listed ${foo.length} times: ${JSON.stringify(foo)}`)
    },
  },
  {
    id: "G10",
    title:
      "a plugin folder loads the existing package.json exports entry (./server, else .), never an unexported index.ts, recovers once its missing dependency is installed, drops an entry outside the folder without listing it, and loads an entry named ..entry.ts",
    run: async (w) => {
      const folder = path.join(w.vibestHome, "plugins", "packaged")
      await write(
        path.join(folder, "package.json"),
        JSON.stringify({
          name: "e2e-packaged",
          type: "module",
          exports: { "./server": "./dist/server.js", ".": { import: "./src/main.ts" } },
        }),
      )
      await write(path.join(folder, "index.ts"), plugin("unexported"))
      await write(
        path.join(folder, "src", "main.ts"),
        `import id from "e2e-dep"\n${plugin("packaged").replace('id: "packaged"', "id")}`,
      )
      await until("the missing dependency reported", async () =>
        (await list(w)).some(
          (p) => p.status === "failed" && p.source.endsWith("main.ts") && (p.error ?? "").includes("e2e-dep"),
        ),
      )
      const dependency = path.join(folder, "node_modules", "e2e-dep")
      await write(path.join(dependency, "package.json"), JSON.stringify({ name: "e2e-dep", exports: "./index.js" }))
      await write(path.join(dependency, "index.js"), `export default "packaged"\n`)
      await until("the plugin active after the install", async () =>
        (await list(w)).some((p) => p.id === "packaged" && p.status === "active" && p.source.endsWith("main.ts")),
      )
      expect(!(await list(w)).some((p) => p.id === "unexported"), "the folder's unexported index.ts was loaded")
      await fs.rm(folder, { recursive: true })

      const outside = path.join(w.root, "outside.ts")
      await write(outside, plugin("escaped"))
      const escaping = path.join(w.vibestHome, "plugins", "escaping")
      await write(
        path.join(escaping, "package.json"),
        JSON.stringify({ name: "e2e-escaping", type: "module", exports: path.relative(escaping, outside) }),
      )
      const dotted = path.join(w.vibestHome, "plugins", "dotted")
      await write(
        path.join(dotted, "package.json"),
        JSON.stringify({ name: "e2e-dotted", type: "module", exports: "./..entry.ts" }),
      )
      await write(path.join(dotted, "..entry.ts"), plugin("dotted"))
      await until("the dotted entry active", async () =>
        (await list(w)).some((p) => p.id === "dotted" && p.status === "active"),
      )
      const all = await list(w)
      expect(
        !all.some((p) => p.id === "escaped" || p.source.includes("escaping")),
        `an entry outside the plugin folder was listed: ${JSON.stringify(all)}`,
      )
      await fs.rm(dotted, { recursive: true })
      await fs.rm(escaping, { recursive: true })
    },
  },
]

export default checks
