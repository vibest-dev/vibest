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
  // Nothing in the engine depends on the product package either.
  assert.notInclude(fs.readFileSync(path.join(root, "packages/core/package.json"), "utf8"), '"@vibest/vibest"')
})

it("the engine holds no SQL: storage is a port (storage.ts), vibest's SQLite store implements it", () => {
  const core = sources("packages/core/src")
  assert.deepStrictEqual(
    core.flatMap((f) =>
      specifiers(f)
        .filter((s) => /sql/i.test(s))
        .map((s) => `${f}: ${s}`),
    ),
    [],
  )
  assert.deepStrictEqual(importing(core, /\bSqlClient\b|\bsql`/), [])
  const manifest = fs.readFileSync(path.join(root, "packages/core/package.json"), "utf8")
  assert.notMatch(manifest, /sql/i)
  // The schema, its checks and the SQL live in the product's store.
  assert.match(
    fs.readFileSync(path.join(root, "packages/vibest/src/sqlite-storage.ts"), "utf8"),
    /CREATE TABLE session/,
  )
})

it("the engine-only product (engine-only.test.ts) is composed without vibest's product, server or default plugins", () => {
  const files = ["apps/vibest/test/engine-only.test.ts", "apps/vibest/test/fake-runtime.ts"]
  const allowed = /^(node:|\.|effect(\/|$)|@effect\/|@vibest\/(core|plugin|protocol|schema)(\/|$))/
  assert.deepStrictEqual(
    files.flatMap((f) =>
      specifiers(f)
        .filter((s) => !allowed.test(s))
        .map((s) => `${f}: ${s}`),
    ),
    [],
  )
})

it("the product's notions stay out of the engine", () => {
  const core = sources("packages/core/src")
  // Where worktrees go and how they are named, the project's files and the system prompt text are the product's
  // (@vibest/vibest: workspace, placement, system-prompt).
  assert.deepStrictEqual(
    importing(
      core,
      /layout\.(worktrees|scratch)\b|allocationWorktree|ALLOCATION_LEAF|"instructions\.md"|You are agent \$\{/,
    ),
    [],
  )
  // The shared files directory reaches a session through the workspace's `files`, the guard's area through
  // `GuardArea`: the engine names neither.
  assert.deepStrictEqual(importing(core, /VIBEST_SCRATCH|layout\.projects?\b/), [])
  // The storage port and the inbox group by an opaque scope with an owner, not by project and coordinator.
  for (const file of ["storage.ts", "inbox.ts", "memory-storage.ts", "read-model.ts"])
    assert.notMatch(
      fs.readFileSync(path.join(root, "packages/core/src", file), "utf8"),
      /projectId|coordinator(Of|At|Launch|Pending|s\b)|pendingProjects|projectOfSession|entry_session/,
      file,
    )
  // Terminal placement, removal and the system prompt file know no entry agent: the product's policy decides.
  for (const file of ["placement.ts", "remove.ts", "system-prompt.ts", "workspace.ts"])
    assert.notMatch(
      fs.readFileSync(path.join(root, "packages/core/src", file), "utf8"),
      /coordinatorOf|projectDirectory/,
      file,
    )
})
