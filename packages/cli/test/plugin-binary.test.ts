import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { assert, it } from "@effect/vitest"
import { connect, probe, protocolHeaders } from "@vibest/client/client"
import type { PluginInfo } from "@vibest/core/plugins"
import { Effect } from "effect"

import * as Platform from "#platform"

import { note } from "../../../tools/reap.ts"

const pkg = path.join(import.meta.dirname, "..")
const binary = path.join(pkg, "dist", "vibest")

const plugins: Record<string, string> = {
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
  "bundled/index.ts": `import { Plugin } from "@vibest/plugin"
import * as E from "effect"
export default Plugin.define({ id: "bundled", effect: (ctx) => ("ownCopy" in E ? E.Effect.die("own copy") : ctx.agent.hook("start.before", () => E.Effect.void)) })
`,
  "bundled/node_modules/effect/package.json": `{ "name": "effect", "version": "0.0.0", "type": "module", "main": "index.js" }`,
  "bundled/node_modules/effect/index.js": "export const ownCopy = true\n",
  "broken.ts": "export default 42\n",
}

const userEnv = (home: string) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    VIBEST_HOME: home,
    PATH: "/usr/bin:/bin",
    HC_SOCKET: path.join(home, "hc.sock"),
  }
  delete env.VIBEST_SESSION_ID
  delete env.VIBEST_AGENT
  return env
}

const withVibestd = async (home: string, f: (list: () => Promise<ReadonlyArray<PluginInfo>>) => Promise<void>) => {
  const socket = path.join(home, "vibest.sock")
  const log = path.join(home, "vibestd.log")
  const rpc = <A>(effect: Effect.Effect<A, unknown, Effect.Services<ReturnType<typeof probe>>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Platform.services)))
  const daemon = Bun.spawn([binary, "daemon", "--foreground"], {
    env: userEnv(home),
    stdout: "ignore",
    stderr: Bun.file(log),
  })
  note(daemon.pid, `${binary} daemon --foreground`)
  try {
    for (const deadline = Date.now() + 10_000; !(await rpc(probe(socket))); await Bun.sleep(100)) {
      if (daemon.exitCode !== null || Date.now() > deadline)
        assert.fail(`vibestd did not come up:\n${await fs.readFile(log, "utf8").catch(() => "")}`)
    }
    await f(() =>
      rpc(
        connect(socket).pipe(
          Effect.flatMap((client) => client.Plugins(undefined, { headers: protocolHeaders() })),
          Effect.map((listed) => listed.filter((p) => !p.source.startsWith("builtin:"))),
          Effect.scoped,
        ),
      ),
    )
  } finally {
    if (daemon.exitCode === null) daemon.kill()
    for (const deadline = Date.now() + 2_000; daemon.exitCode === null && Date.now() < deadline;) await Bun.sleep(50)
    if (daemon.exitCode === null) daemon.kill("SIGKILL")
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

it(
  "P11: the compiled binary maps effect, effect/* and @vibest/plugin to its own instances, even for a plugin with its own copy of effect",
  { timeout: 60_000 },
  async () => {
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
  },
)

const fsEventsDeliveryUnderLoadMs = 60_000

const listUntil = async (
  list: () => Promise<ReadonlyArray<PluginInfo>>,
  done: (listed: ReadonlyArray<PluginInfo>) => boolean,
) => {
  let listed: ReadonlyArray<PluginInfo> = []
  for (const deadline = Date.now() + fsEventsDeliveryUnderLoadMs; Date.now() < deadline; await Bun.sleep(100)) {
    listed = await list()
    if (done(listed)) return listed
  }
  return assert.fail(`gave up; last listing: ${JSON.stringify(listed)}`)
}

it(
  "a plugin's lazy import, imported again once another plugin loads, is the same module evaluated once",
  { timeout: 180_000 },
  async () => {
    build()
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-lazy-"))
    const log = path.join(home, "lazy.log")
    await fs.mkdir(path.join(home, "plugins", "lazy"), { recursive: true })
    await fs.writeFile(
      path.join(home, "plugins", "lazy", "lazy.ts"),
      `import fs from "node:fs"\nfs.appendFileSync(process.env.VIBEST_HOME + "/lazy.log", "evaluated\\n")\n`,
    )
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
        await listUntil(list, (l) => l[0]?.status === "active")
        await fs.writeFile(
          path.join(home, "plugins", "zz-other.ts"),
          `import { Plugin } from "@vibest/plugin"\nimport { Effect } from "effect"\nexport default Plugin.define({ id: "other", effect: () => Effect.void })\n`,
        )
        await listUntil(list, (l) => l[1]?.status === "active")
        await fs.writeFile(path.join(home, "trigger"), "")
        const lines = async () => (await fs.readFile(log, "utf8")).trim().split("\n")
        for (const deadline = Date.now() + 15_000; (await lines()).length < 2 && Date.now() < deadline;)
          await Bun.sleep(100)
        assert.deepStrictEqual(await lines(), ["evaluated", "same"])
      })
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  },
)
