import type { Check } from "../check.ts"
import { expect, Skip, type World } from "../world.ts"

const HARNESSES = ["claude", "pi", "cursor"] as const
type Listed = { harness: string; binary: string; available: boolean; error: string | null }
type Models = { models: Array<{ harness: string; model: string }>; errors?: Array<string> }

const listed = (w: World) => w.json<Array<Listed>>(["harness", "list"], { timeoutMs: 120_000 })

const checks: ReadonlyArray<Check> = [
  {
    id: "H1",
    title: "harness list: one entry per harness; a missing CLI says so",
    run: async (w) => {
      const all = await listed(w)
      expect(
        HARNESSES.every((h) => all.some((e) => e.harness === h)) && all.length === HARNESSES.length,
        `entries: ${JSON.stringify(all)}`,
      )
      for (const e of all)
        expect(
          e.available === (Bun.which(e.binary) !== null),
          `${e.harness}: available ${e.available}, on PATH ${Bun.which(e.binary)}`,
        )
      for (const e of all.filter((e) => !e.available))
        expect(!!e.error?.includes("not on PATH"), `${e.harness}: missing without saying why`)
    },
  },
  {
    id: "H2",
    title: "harness models: a non-empty list for each installed harness",
    run: async (w) => {
      const installed = (await listed(w)).filter((e) => e.available).map((e) => e.harness)
      if (installed.length === 0) throw new Skip("no harness CLI on PATH")
      for (const h of installed) {
        const r = await w.json<Models>(["harness", "models", h], { timeoutMs: 120_000 })
        expect(
          r.models.length > 0 && r.models.every((m) => m.harness === h),
          `${h}: ${JSON.stringify(r).slice(0, 400)}`,
        )
      }
      const missing = HARNESSES.filter((h) => !installed.includes(h))
      if (missing.length) throw new Skip(`checked ${installed.join(", ")}; not on PATH: ${missing.join(", ")}`)
    },
  },
  {
    id: "H3",
    title:
      "doctor: grouped, one line per harness for vibest (binary, plugin, models) and one for herdr seeing its state, then a verdict",
    run: async (w) => {
      const out = await w.ok(["doctor"], { timeoutMs: 120_000 })
      for (const h of HARNESSES) {
        expect(new RegExp(`^  [✓✗] ${h} +\\d+ models|^  ✗ ${h} `, "m").test(out), `no agent line for ${h}:\n${out}`)
        // herdr's line is only for a harness vibest can start.
        if (new RegExp(`^  ✓ ${h} +\\d+ models`, "m").test(out))
          expect(
            new RegExp(`^  [✓✗] ${h} +herdr can(not)? see its state`, "m").test(out),
            `no herdr line for ${h}:\n${out}`,
          )
      }
      expect(
        /^Runtime: herdr .*\(where agents run\)$/m.test(out) &&
          /^(Ready\.|\d+ problems?; run the fix lines above\.)$/m.test(out),
        `no herdr runtime section or verdict:\n${out}`,
      )
    },
  },
]

export default checks
