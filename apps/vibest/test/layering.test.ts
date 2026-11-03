// The dependency rule (architecture.md, layering): the command line is a client of vibestd and of the product layer,
// never of the engine; the engine runs no git and knows no worktree (the workspace port does).
import fs from "node:fs"
import path from "node:path"

import { assert, it } from "@effect/vitest"

const root = path.resolve(import.meta.dirname, "../../..")

const sources = (dir: string): Array<string> =>
  fs
    .readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(dir, f))

const importing = (files: ReadonlyArray<string>, pattern: RegExp) =>
  files.filter((f) => pattern.test(fs.readFileSync(path.join(root, f), "utf8")))

it("the command line imports nothing of the engine; only the vibestd host platform does", () => {
  const cli = sources("apps/vibest/src").filter((f) => !f.startsWith("apps/vibest/src/platform/"))
  assert.deepStrictEqual(importing(cli, /from "@vibest\/core\//), [])
})

it("the engine runs no git and imports no worktree code", () => {
  const core = sources("packages/core/src")
  assert.deepStrictEqual(
    importing(core, /ChildProcess\.make\("git"|from "\.\/(worktree|project-create)\.ts"|from "@vibest\/vibest\//),
    [],
  )
})
