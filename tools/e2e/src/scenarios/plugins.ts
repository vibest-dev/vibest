import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { expect, until, type World } from "../world.ts"

type Info = { id: string; source: string; status: "active" | "failed"; error?: string; calls: number; refused: number }

const list = (w: World) => w.json<Array<Info>>(["plugins"])

const plugin = (id: string, hook = "() => Effect.void") => `import { AgentRefused, Plugin } from "@vibest/plugin"
import { Effect } from "effect"
export default Plugin.define({ id: ${JSON.stringify(id)}, effect: (ctx) => ctx.agent.hook("start.before", ${hook}) })
`

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(`${file}.tmp`, text)
  await fs.rename(`${file}.tmp`, file)
}

const checks: ReadonlyArray<Check> = [
  {
    id: "G1",
    title: "plugins lists one from VIBEST_HOME/plugins and one from vibest.json",
    run: async (w) => {
      await write(path.join(w.vibestHome, "plugins", "home.ts"), plugin("home"))
      const configured = path.join(w.root, "configured", "index.ts")
      await write(configured, plugin("configured"))
      await write(path.join(w.vibestHome, "vibest.json"), JSON.stringify({ plugins: [path.dirname(configured)] }))
      await until("both plugins active", async () => {
        const all = await list(w)
        return ["home", "configured"].every((id) => all.some((p) => p.id === id && p.status === "active"))
      })
    },
  },
  {
    id: "G2",
    title: "editing a plugin reloads it without restarting vibestd",
    run: async (w) => {
      await write(path.join(w.vibestHome, "plugins", "home.ts"), plugin("home"))
      await until("the plugin loaded", async () =>
        (await list(w)).some((p) => p.id === "home" && p.status === "active"),
      )
      const pid = await w.daemonPid()
      await write(path.join(w.vibestHome, "plugins", "home.ts"), plugin("home-v2"))
      await until("the edited plugin loaded", async () =>
        (await list(w)).some((p) => p.id === "home-v2" && p.status === "active"),
      )
      expect((await w.daemonPid()) === pid, "vibestd restarted")
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
      await until("the failure reported", async () => {
        const all = await list(w)
        return (
          all.some((p) => p.status === "failed" && p.source.endsWith("broken.ts")) &&
          all.some((p) => p.id === "steady" && p.status === "active")
        )
      })
      await fs.rm(path.join(w.vibestHome, "plugins", "broken.ts"))
      await fs.rm(steady)
    },
  },
  {
    id: "G4",
    title: "a refusing agent.start.before blocks run with its reason, before any worktree",
    run: async (w) => {
      await write(
        path.join(w.vibestHome, "plugins", "refuse.ts"),
        plugin("refuse", `() => Effect.fail(new AgentRefused({ reason: "e2e says no" }))`),
      )
      await until("the refusing plugin active", async () =>
        (await list(w)).some((p) => p.id === "refuse" && p.status === "active"),
      )
      const worktrees = path.join(w.vibestHome, "worktrees")
      const before = await fs.readdir(worktrees).catch(() => [])
      const r = await w.vibest(["run", "pi", "--session", w.herdrSession, "--", "do nothing"], { timeoutMs: 60_000 })
      expect(r.code !== 0, `run exited 0: ${r.stdout}`)
      expect(r.stderr.includes("e2e says no"), `reason not shown: ${r.stderr}`)
      expect((await fs.readdir(worktrees).catch(() => [])).length === before.length, "a worktree was created")
      const { length } = await w.json<{ sessions: Array<unknown> }>(["ls", "--all"]).then((l) => l.sessions)
      expect(length === 0, "a session row was written")
      expect(
        (await list(w)).some((p) => p.id === "refuse" && p.refused === 1),
        "the refusal was not counted",
      )
      await fs.rm(path.join(w.vibestHome, "plugins", "refuse.ts"))
    },
  },
]

export default checks
