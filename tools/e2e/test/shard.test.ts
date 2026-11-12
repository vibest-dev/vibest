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
  test("12 shards run every gate check exactly once", () => {
    const count = 12
    const ran = Array.from({ length: count }, (_, i) => shardOf(gateIds, { index: i + 1, count }).map((c) => c.id))
    expect(ran.flat().sort()).toEqual(gateIds.map((c) => c.id).sort())
  })
})

describe("the release workflow", () => {
  test("its shard matrix has exactly SHARDS entries, 1 to SHARDS", async () => {
    const text = await Bun.file(path.join(import.meta.dirname, "../../../.github/workflows/release.yml")).text()
    const count = Number(/^\s+SHARDS: (\d+)$/m.exec(text)?.[1])
    const listed = /^\s+shard: \[([\d, ]+)\]$/m.exec(text)?.[1]?.split(",").map(Number)
    expect(listed).toEqual(Array.from({ length: count }, (_, i) => i + 1))
  })
})
