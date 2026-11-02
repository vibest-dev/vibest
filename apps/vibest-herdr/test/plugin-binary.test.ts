// The compiled binary (plugins.md §6): P11, plugins share vibestd's `effect` and `@vibest/plugin`, even with a copy of
// their own next to them; P16/P17, a running vibestd reloads changed imports (top-level await included) with the real
// loader. Builds dist/vibest, starts vibestd on a temp VIBEST_HOME (no herdr needed) and asks it over its socket.
import { assert, it } from "@effect/vitest"
import * as Platform from "#platform"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { connect, probe, protocolHeaders } from "@vibest/client/client"
import type { PluginInfo } from "@vibest/core/plugins"

const pkg = path.join(import.meta.dirname, "..")
const binary = path.join(pkg, "dist", "vibest")

const plugins: Record<string, string> = {
  // Root namespace, a mapped subpath and the SDK, all used in setup and the hook.
  "shared.ts": `import { AgentRefused, Plugin } from "@vibest/plugin"
import { Effect } from "effect"
import * as S from "effect/Schema"
export default Plugin.define({
  id: "shared",
  effect: (ctx) => S.is(S.String)("x") && new AgentRefused({ plugin: "shared", reason: "r" })._tag === "AgentRefused"
    ? ctx.agent.hook("start.before", () => Effect.void)
    : Effect.die("effect/Schema or @vibest/plugin is not usable"),
})
`,
  // A plugin with its own `effect`: the mapping must win, or `Effect` is undefined and setup throws.
  "bundled/index.ts": `import { Plugin } from "@vibest/plugin"
import * as E from "effect"
export default Plugin.define({ id: "bundled", effect: (ctx) => ("ownCopy" in E ? E.Effect.die("own copy") : ctx.agent.hook("start.before", () => E.Effect.void)) })
`,
  "bundled/node_modules/effect/package.json": `{ "name": "effect", "version": "0.0.0", "type": "module", "main": "index.js" }`,
  "bundled/node_modules/effect/index.js": "export const ownCopy = true\n",
  "broken.ts": "export default 42\n",
}

/** The user's environment: none of the agent roles this test run may have inherited (it can run inside an vibest session). */
const userEnv = (home: string) => {
  // PATH stops at the system directories: vibestd polls whatever harness is installed, and this test must not.
  const env: Record<string, string | undefined> = { ...process.env, VIBEST_HOME: home, PATH: "/usr/bin:/bin" }
  delete env.VIBEST_SESSION_ID
  delete env.VIBEST_AGENT
  return env
}

/**
 * Start vibestd on `home` in the foreground, run `f` with a way to list its plugins, then stop it. vibestd is asked over its
 * socket directly, never through the `vibest` CLI: the CLI starts an vibestd of its own when a Ping is slow, which would leave
 * a second, untracked one behind. Not up within 10s fails the test.
 */
const withVibestd = async (home: string, f: (list: () => Promise<ReadonlyArray<PluginInfo>>) => Promise<void>) => {
  const socket = path.join(home, "vibest.sock")
  const log = path.join(home, "vibestd.log")
  const rpc = <A>(effect: Effect.Effect<A, unknown, Effect.Services<ReturnType<typeof probe>>>) => Effect.runPromise(effect.pipe(Effect.provide(Platform.services)))
  const daemon = Bun.spawn([binary, "daemon", "--foreground"], { env: userEnv(home), stdout: "ignore", stderr: Bun.file(log) })
  try {
    for (const deadline = Date.now() + 10_000; !(await rpc(probe(socket))); await Bun.sleep(100)) {
      if (daemon.exitCode !== null || Date.now() > deadline) assert.fail(`vibestd did not come up:\n${await fs.readFile(log, "utf8").catch(() => "")}`)
    }
    // The builtin default harness choice is always vibestd's first plugin; these tests watch the user's files.
    await f(() => rpc(connect(socket).pipe(
      Effect.flatMap((client) => client.Plugins(undefined, { headers: protocolHeaders() })),
      Effect.map((listed) => listed.filter((p) => p.id !== "harness-choice")),
      Effect.scoped,
    )))
  } finally {
    daemon.kill()
    await daemon.exited
  }
}

let built = false
const build = () => {
  if (built) return
  const out = Bun.spawnSync(["bun", "run", "build"], { cwd: pkg, stdout: "pipe", stderr: "pipe" })
  assert.strictEqual(out.exitCode, 0, out.stderr.toString())
  built = true
}

it("P11: the compiled binary maps effect, effect/* and @vibest/plugin to its own instances", { timeout: 60_000 }, async () => {
  build()
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-p11-"))
  for (const [file, content] of Object.entries(plugins)) {
    await fs.mkdir(path.dirname(path.join(home, "plugins", file)), { recursive: true })
    await fs.writeFile(path.join(home, "plugins", file), content)
  }
  try {
    await withVibestd(home, async (list) => {
      const status = Object.fromEntries((await list()).map((p) => [path.basename(p.id), [p.status, p.error]]))
      assert.deepStrictEqual(status["shared"], ["active", undefined])
      assert.deepStrictEqual(status["bundled"], ["active", undefined])
      assert.strictEqual(status["broken.ts"]?.[0], "failed")
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

const byId = (listed: ReadonlyArray<PluginInfo>, id: string) => listed.find((p) => p.id === id)

/** `list` until `done` holds (15s at most). */
const until = async (list: () => Promise<ReadonlyArray<PluginInfo>>, done: (listed: ReadonlyArray<PluginInfo>) => boolean) => {
  let listed: ReadonlyArray<PluginInfo> = []
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(100)) {
    listed = await list()
    if (done(listed)) return listed
  }
  return assert.fail(`gave up; last listing: ${JSON.stringify(listed)}`)
}

it("P16/P17: the running binary reloads changed async imports, keeps the last good one while broken or hung, recovers", { timeout: 90_000 }, async () => {
  build()
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-reload-"))
  const setups = path.join(home, "setups.log")
  const version = path.join(home, "shared", "version.ts")
  await fs.mkdir(path.join(home, "plugins"), { recursive: true })
  await fs.mkdir(path.dirname(version))
  // Both the plugin and its dependency wait at top level, as stage 1 allowed.
  const versionFile = (v: string) => `await new Promise((r) => setTimeout(r, 10))\nexport const version = "${v}"\n`
  await fs.writeFile(version, versionFile("v1"))
  // Each setup appends the version it imported; only the shared file ever changes.
  await fs.writeFile(
    path.join(home, "plugins", "live.ts"),
    `import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
import fs from "node:fs"
import { version } from "../shared/version.ts"
await new Promise((r) => setTimeout(r, 10))
export default Plugin.define({ id: "live", effect: () => Effect.sync(() => fs.appendFileSync(process.env.VIBEST_HOME + "/setups.log", version + "\\n")) })
`,
  )
  const log = async () => (await fs.readFile(setups, "utf8")).trim().split("\n")
  try {
    await withVibestd(home, async (list) => {
      const first = byId(await until(list, (l) => byId(l, "live")?.status === "active"), "live")!
      assert.deepStrictEqual(await log(), ["v1"])

      // VIBEST_HOME is under os.tmpdir(), which on macOS is behind the /var symlink: a plugin added now must load too.
      await fs.writeFile(path.join(home, "plugins", "zz-added.ts"), `import { Plugin } from "@vibest/plugin"\nimport { Effect } from "effect"\nexport default Plugin.define({ id: "added", effect: () => Effect.void })\n`)
      const added = byId(await until(list, (l) => byId(l, "added")?.status === "active"), "added")!
      assert.deepInclude(added, { id: "added", status: "active" })

      await fs.writeFile(version, versionFile("v2"))
      const second = byId(await until(list, (l) => byId(l, "live") !== undefined && byId(l, "live")!.revision !== first.revision), "live")!
      assert.strictEqual(second!.status, "active")
      assert.deepStrictEqual(await log(), ["v1", "v2"])

      await fs.writeFile(version, `export const version = (() => { throw new Error("broken on purpose") })()\n`)
      const broken = byId(await until(list, (l) => byId(l, "live")?.error !== undefined), "live")!
      assert.deepInclude(broken, { status: "active", revision: second!.revision })
      assert.include(broken!.error, "broken on purpose", broken!.error)

      // A top-level await that never settles: the import gives up after 5s, and the listing never waits more than 10s.
      await fs.writeFile(version, `export const version = await new Promise(() => {})\n`)
      const started = Date.now()
      const hung = byId(await until(list, (l) => byId(l, "live")?.error?.includes("import timed out") === true), "live")!
      assert.isBelow(Date.now() - started, 12_000)
      assert.deepInclude(hung, { status: "active", revision: second!.revision })

      await fs.writeFile(version, versionFile("v3"))
      const fixed = byId(await until(list, (l) => byId(l, "live") !== undefined && byId(l, "live")!.error === undefined && byId(l, "live")!.revision !== second.revision), "live")!
      assert.strictEqual(fixed!.status, "active")
      // Each failed revision set v2 up again in its place.
      assert.deepStrictEqual(await log(), ["v1", "v2", "v2", "v2", "v3"])
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

it("a plugin's lazy import stays one module while another plugin loads", { timeout: 90_000 }, async () => {
  build()
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-lazy-"))
  const log = path.join(home, "lazy.log")
  await fs.mkdir(path.join(home, "plugins", "lazy"), { recursive: true })
  // Each evaluation of lazy.ts logs once; once `trigger` exists the plugin imports it again and logs whether it got the same module.
  await fs.writeFile(path.join(home, "plugins", "lazy", "lazy.ts"), `import fs from "node:fs"\nfs.appendFileSync(process.env.VIBEST_HOME + "/lazy.log", "evaluated\\n")\n`)
  await fs.writeFile(
    path.join(home, "plugins", "lazy", "index.ts"),
    `import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
import fs from "node:fs"
const home = process.env.VIBEST_HOME!
const lazy = () => import("./lazy.ts")
export default Plugin.define({
  id: "lazy",
  effect: () =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(lazy)
      const timer = setInterval(() => {
        if (!fs.existsSync(home + "/trigger")) return
        clearInterval(timer)
        void lazy().then((again) => fs.appendFileSync(home + "/lazy.log", (again === first ? "same" : "different") + "\\n"))
      }, 50)
      yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(timer)))
    }),
})
`,
  )
  try {
    await withVibestd(home, async (list) => {
      await until(list, (l) => l[0]?.status === "active")
      await fs.writeFile(path.join(home, "plugins", "zz-other.ts"), `import { Plugin } from "@vibest/plugin"\nimport { Effect } from "effect"\nexport default Plugin.define({ id: "other", effect: () => Effect.void })\n`)
      await until(list, (l) => l[1]?.status === "active")
      await fs.writeFile(path.join(home, "trigger"), "")
      const lines = async () => (await fs.readFile(log, "utf8")).trim().split("\n")
      for (const deadline = Date.now() + 15_000; (await lines()).length < 2 && Date.now() < deadline; ) await Bun.sleep(100)
      assert.deepStrictEqual(await lines(), ["evaluated", "same"])
    })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
