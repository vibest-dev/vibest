// The daily start (architecture.md D4): install, `cd shop`, `vibest`. Outside herdr, `vibest` opens a workspace in this
// run's own herdr session whose shell runs `vibest` again and becomes the project's main agent. Pi runs with this run's
// PI_CODING_AGENT_DIR (passed with --env), never the user's. `--new` asks in the pane before stopping the running main
// Agent, so it is covered by unit tests, not here.
import type { Check } from "../check.ts"
import { expect, Skip, until, type World } from "../world.ts"

type Entry = { id: string; agent: string; harness: string; routing?: { trace: Array<{ hook: string }> } }

const mains = async (w: World) => (await w.json<Array<Entry>>(["ls"])).filter((e) => e.agent === "main")
const start = (w: World) =>
  w.ok(["--harness", "pi", "--session", w.herdrSession, "--headless", "--env", `PI_CODING_AGENT_DIR=${w.config.pi}`], { timeoutMs: 60_000 })

const checks: ReadonlyArray<Check> = [
  {
    id: "S1",
    title: "in a project directory, `vibest` starts its main agent in this run's herdr session; `vibest ls` shows it first",
    run: async (w) => {
      if (!Bun.which("pi")) throw new Skip("pi not on PATH")
      if (!Bun.which("herdr")) throw new Skip("herdr not on PATH")
      const out = await start(w)
      expect(out.includes("the main agent is starting in"), `vibest said: ${out}`)
      await until("the main agent in vibest ls", async () => (await mains(w)).length === 1, 30_000)
      const [main] = await mains(w)
      expect(main!.harness === "pi", `main agent: ${JSON.stringify(main)}`)
      expect(main!.routing === undefined || main!.routing.trace.every((t) => typeof t.hook === "string"), `routing: ${JSON.stringify(main)}`)
    },
  },
]

export default checks
