// Project store (SPEC §5.4, §5.5 Project writes): if_version, path rules, size cap, secret scan, atomic write, list / search / info.
import { assert, describe, it, layer } from "@effect/vitest"
import { Layout } from "@vibest/core/paths"
import { describeEntry, ENTRY_LIMIT, findSecret, pathProblem, Project, type ProjectScope } from "@vibest/vibest/project"
import { Effect, FileSystem, Layer, Path } from "effect"

import * as Platform from "#platform"

import { tempDirectory } from "./fakes.ts"

const scope: ProjectScope = { key: "github.com/acme/app" }

/** A Project service over a fresh temp VIBEST_HOME. */
const withProject = <A, E>(program: Effect.Effect<A, E, Project | Layout | FileSystem.FileSystem | Path.Path>) =>
  Effect.gen(function* () {
    const home = yield* tempDirectory("vibest-project-")
    const layout = Layer.succeed(Layout, yield* Layout.make(home))
    return yield* program.pipe(Effect.provide(Project.layer.pipe(Layer.provideMerge(layout))))
  })

describe("pure", () => {
  it("path rules", () => {
    assert.isUndefined(pathProblem("notes/a.md"))
    assert.match(pathProblem("")!, /1-1024/)
    assert.match(pathProblem("/etc/a.md")!, /relative/)
    assert.match(pathProblem("a/../b.md")!, /segment/)
    assert.match(pathProblem(".hidden/a.md")!, /segment/)
    assert.match(pathProblem("a//b.md")!, /segment/)
    assert.match(pathProblem("a.sh")!, /extension/)
  })

  it("secret scan", () => {
    assert.strictEqual(findSecret("-----BEGIN RSA PRIVATE KEY-----"), "private key")
    assert.strictEqual(findSecret("id AKIAABCDEFGHIJKLMNOP"), "AWS access key")
    assert.strictEqual(findSecret(`ghp_${"a1B2".repeat(10)}`), "GitHub token")
    assert.strictEqual(findSecret("API_TOKEN=Zx8qL2mN7vR4tY1uW9pK3jH6"), "high-entropy credential assignment")
    assert.isUndefined(findSecret("PASSWORD=aaaaaaaaaaaaaaaaaaaaaaaa"))
    assert.isUndefined(findSecret("just notes about the token flow"))
  })

  it("description from frontmatter or first line", () => {
    assert.strictEqual(describeEntry('---\ndescription: "deploy steps"\n---\nbody'), "deploy steps")
    assert.strictEqual(describeEntry("\n# Title here\nmore"), "Title here")
  })
})

layer(Platform.services)("on the platform", (it) => {
  it.effect("write needs the right ifVersion; delete too", () =>
    withProject(
      Effect.gen(function* () {
        const project = yield* Project
        const missing = yield* project
          .write(scope, { kind: "memory", path: "a.md", content: "x", ifVersion: "0123456789abcdef" })
          .pipe(Effect.flip)
        assert.strictEqual(missing._tag, "ProjectConflict")
        const { version } = yield* project.write(scope, {
          kind: "memory",
          path: "a.md",
          content: "one",
          ifVersion: "new",
        })
        assert.lengthOf(version, 16)
        assert.strictEqual(
          (yield* project
            .write(scope, { kind: "memory", path: "a.md", content: "two", ifVersion: "new" })
            .pipe(Effect.flip))._tag,
          "ProjectConflict",
        )
        const stale = yield* project
          .write(scope, { kind: "memory", path: "a.md", content: "two", ifVersion: "ffffffffffffffff" })
          .pipe(Effect.flip)
        assert.match(stale.message, /version mismatch/)
        const v2 = yield* project.write(scope, { kind: "memory", path: "a.md", content: "two", ifVersion: version })
        assert.deepStrictEqual(yield* project.read(scope, { kind: "memory", path: "a.md" }), {
          content: "two",
          version: v2.version,
        })
        assert.strictEqual(
          (yield* project.delete(scope, { kind: "memory", path: "a.md", ifVersion: version }).pipe(Effect.flip))._tag,
          "ProjectConflict",
        )
        yield* project.delete(scope, { kind: "memory", path: "a.md", ifVersion: v2.version })
        assert.strictEqual(
          (yield* project.read(scope, { kind: "memory", path: "a.md" }).pipe(Effect.flip))._tag,
          "ProjectInvalid",
        )
      }),
    ),
  )

  it.effect("a hand edit makes the old version stale", () =>
    withProject(
      Effect.gen(function* () {
        const project = yield* Project
        const layout = yield* Layout
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { version } = yield* project.write(scope, {
          kind: "docs",
          path: "plan.md",
          content: "v1",
          ifVersion: "new",
        })
        yield* fs.writeFileString(path.join(layout.project(scope.key), "docs", "plan.md"), "edited by hand")
        assert.strictEqual(
          (yield* project
            .write(scope, { kind: "docs", path: "plan.md", content: "v2", ifVersion: version })
            .pipe(Effect.flip))._tag,
          "ProjectConflict",
        )
      }),
    ),
  )

  it.effect("bad path, size cap and secrets are refused; nothing lands on disk", () =>
    withProject(
      Effect.gen(function* () {
        const project = yield* Project
        const layout = yield* Layout
        const fs = yield* FileSystem.FileSystem
        const refused = [
          project.write(scope, { kind: "docs", path: "../escape.md", content: "x", ifVersion: "new" }),
          project.write(scope, {
            kind: "docs",
            path: "big.md",
            content: "a".repeat(ENTRY_LIMIT + 1),
            ifVersion: "new",
          }),
          project.write(scope, {
            kind: "docs",
            path: "key.md",
            content: "-----BEGIN OPENSSH PRIVATE KEY-----",
            ifVersion: "new",
          }),
        ]
        for (const attempt of refused) assert.strictEqual((yield* Effect.flip(attempt))._tag, "ProjectInvalid")
        assert.isFalse(yield* fs.exists(layout.project(scope.key)))
      }),
    ),
  )

  it.effect("atomic write leaves no temp files", () =>
    withProject(
      Effect.gen(function* () {
        const project = yield* Project
        const layout = yield* Layout
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* project.write(scope, { kind: "docs", path: "a.md", content: "x", ifVersion: "new" })
        assert.deepStrictEqual(yield* fs.readDirectory(path.join(layout.project(scope.key), "docs")), ["a.md"])
      }),
    ),
  )

  it.effect("list, search and info; scratch is per owner", () =>
    withProject(
      Effect.gen(function* () {
        const project = yield* Project
        const layout = yield* Layout
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* project.write(scope, {
          kind: "docs",
          path: "b/deep.md",
          content: "---\ndescription: deep doc\n---\nNeedle here",
          ifVersion: "new",
        })
        yield* project.write(scope, { kind: "docs", path: "a.txt", content: "first line\nno match", ifVersion: "new" })
        yield* project.write(scope, {
          kind: "scratch",
          path: "w1-notes.md",
          content: "needle in scratch",
          ifVersion: "new",
        })
        // Hidden and non-whitelisted files are not entries.
        yield* fs.writeFileString(path.join(layout.project(scope.key), "docs", "skip.sh"), "needle")

        const docs = yield* project.list(scope, { kind: "docs" })
        assert.deepStrictEqual(
          docs.map((e) => [e.path, e.description]),
          [
            ["a.txt", "first line"],
            ["b/deep.md", "deep doc"],
          ],
        )
        assert.deepStrictEqual(yield* project.search(scope, { query: "NEEDLE" }), [
          "docs/b/deep.md:4: Needle here",
          "scratch/w1-notes.md:1: needle in scratch",
        ])
        assert.deepStrictEqual(yield* project.search(scope, { query: "needle", kind: "docs" }), [
          "docs/b/deep.md:4: Needle here",
        ])

        yield* fs.writeFileString(path.join(layout.project(scope.key), "instructions.md"), "be nice")
        const info = yield* project.info(scope)
        assert.strictEqual(info.instructions, "be nice")
        assert.strictEqual(info.scratchPath, layout.scratch(scope.key))
        assert.lengthOf(info.scratch, 1)
      }),
    ),
  )
})
