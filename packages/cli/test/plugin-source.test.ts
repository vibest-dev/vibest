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

it("a dependency installed after a failed lookup is watched while missing and resolves once installed", async () => {
  const dir = await folder()
  const entry = path.join(dir, "src", "main.ts")
  const installed = path.join(dir, "node_modules", "e2e-dep")
  await write(entry, 'import dep from "e2e-dep"\nimport { Effect } from "effect"\nexport default [dep, Effect]\n')
  assert.throws(() => Bun.resolveSync("e2e-dep", path.dirname(entry)))
  const missing = Platform.plugins.graph(entry).unresolved
  assert.include(missing, installed)
  assert.notInclude(missing.join("\n"), "effect")

  await write(path.join(installed, "package.json"), JSON.stringify({ name: "e2e-dep", exports: "./index.js" }))
  await write(path.join(installed, "index.js"), "export default 1\n")
  assert.deepStrictEqual(Platform.plugins.graph(entry).unresolved, [])
  assert.strictEqual(Bun.resolveSync("e2e-dep", path.dirname(entry)), path.join(installed, "index.js"))
  await fs.rm(dir, { recursive: true })
})
