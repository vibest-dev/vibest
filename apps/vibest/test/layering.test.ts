// The dependency rule (architecture.md, layering): the frontends (the command line, the herdr plugin) are clients of
// vibestd: they import the client, the contracts and the server's one entry, nothing of the daemon, the product or the
// engine; the engine runs no git and knows no worktree (the workspace port does).
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

/** Every specifier `file` imports or re-exports (`import … from "x"`, `export … from "x"`, `import("x")`). */
const specifiers = (file: string) =>
  [
    ...fs
      .readFileSync(path.join(root, file), "utf8")
      .matchAll(/^\s*(?:import|export)\b[^"]*?\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm),
  ].map((m) => (m[1] ?? m[2] ?? m[3])!)

it("the frontends import only the client, the contracts, effect and the server's entry", () => {
  const allowed = /^(node:|\.|#platform$|effect(\/|$)|@vibest\/(client|protocol|schema)\/|@vibest\/server\/entry$)/
  const wrong = sources("apps/vibest/src").flatMap((f) =>
    specifiers(f)
      .filter((s) => !allowed.test(s))
      .map((s) => `${f}: ${s}`),
  )
  assert.deepStrictEqual(wrong, [])
})

it("the engine runs no git and imports no worktree code or the product", () => {
  const core = sources("packages/core/src")
  assert.deepStrictEqual(
    importing(core, /ChildProcess\.make\("git"|from "\.\/(worktree|project-create)\.ts"|from "@vibest\/vibest\//),
    [],
  )
})
