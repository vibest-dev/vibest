import { expect, test } from "bun:test"
import path from "node:path"

const main = path.join(import.meta.dirname, "../src/main.ts")
const workflow = path.join(import.meta.dirname, "../../.github/workflows/release.yml")

type Suite = { name: string; areas: string }

type Release = { jobs: { e2e: { strategy: { matrix: { suite: ReadonlyArray<Suite> } } } } }

test("the release workflow's e2e suites name every area exactly once", async () => {
  const listed = JSON.parse(Bun.spawnSync(["bun", main, "--list"]).stdout.toString()) as Array<{ area?: string }>
  const areas = [...new Set(listed.flatMap((c) => (c.area ? [c.area] : [])))].sort()
  const release = Bun.YAML.parse(await Bun.file(workflow).text()) as Release
  const named = release.jobs.e2e.strategy.matrix.suite.flatMap((s) => s.areas.split(" ")).sort()

  expect(named).toEqual(areas)
})
