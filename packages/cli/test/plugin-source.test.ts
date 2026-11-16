import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { assert, it } from "@effect/vitest"

import * as Platform from "#platform"

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

const folder = async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vibest-plugin-source-")))

it("a dependency is watched in the plugin package until it resolves, even while its folder is half installed", async () => {
  const dir = await folder()
  const entry = path.join(dir, "src", "main.ts")
  const installed = path.join(dir, "node_modules", "e2e-dep")
  await write(path.join(dir, "package.json"), JSON.stringify({ name: "e2e-packaged", exports: "./src/main.ts" }))
  await write(
    entry,
    'import dep from "e2e-dep"\nimport { Effect } from "effect"\nimport { ChildProcess } from "effect/process"\nimport { Plugin } from "@vibest/plugin/effect"\nexport default [dep, Effect, ChildProcess, Plugin]\n',
  )
  assert.throws(() => Bun.resolveSync("e2e-dep", path.dirname(entry)))
  assert.deepStrictEqual(Platform.makePluginLoader().graph(entry).unresolved.toSorted(), [
    installed,
    path.join(dir, "src", "node_modules", "e2e-dep"),
  ])

  await write(path.join(installed, "package.json"), JSON.stringify({ name: "e2e-dep", exports: "./index.js" }))
  assert.deepStrictEqual(Platform.makePluginLoader().graph(entry).unresolved, [installed])
  await write(path.join(installed, "index.js"), "export default 1\n")
  assert.deepStrictEqual(Platform.makePluginLoader().graph(entry).unresolved, [])
  assert.strictEqual(Bun.resolveSync("e2e-dep", path.dirname(entry)), path.join(installed, "index.js"))
  await fs.rm(dir, { recursive: true })
})
