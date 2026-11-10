import { describe, expect, test } from "bun:test"
import path from "node:path"

import { shardOf } from "../src/runner/shard.ts"

const main = path.join(import.meta.dirname, "../src/main.ts")
const gateIds = (
  JSON.parse(Bun.spawnSync(["bun", main, "--list"]).stdout.toString()) as Array<{ id: string; tier: string }>
)
  .filter((c) => c.tier === "gate" && c.id !== "I6")
  .map(({ id }) => ({ id }))

describe("shards", () => {
  for (const count of [1, 5, 6, 12])
    test(`${count} shards run every gate check exactly once`, () => {
      const ran = Array.from({ length: count }, (_, i) => shardOf(gateIds, { index: i + 1, count }).map((c) => c.id))
      expect(ran.flat().sort()).toEqual(gateIds.map((c) => c.id).sort())
    })
})
