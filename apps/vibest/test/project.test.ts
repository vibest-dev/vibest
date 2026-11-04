// The project folder (SPEC §5.4): info names its paths, search reads docs, memories and artifacts.
import { assert, describe, it } from "@effect/vitest"
import { Layout } from "@vibest/core/paths"
import { Project, type ProjectScope } from "@vibest/vibest/project"
import { Effect, FileSystem, Layer, Path } from "effect"

import * as Platform from "#platform"

import { tempDirectory } from "./fakes.ts"

const scope: ProjectScope = { id: "0f5a8b2c-1d3e-4f60-8a7b-9c0d1e2f3a4b" }

/** A Project service over a fresh temp VIBEST_HOME. */
const withProject = <A, E>(program: Effect.Effect<A, E, Project | Layout | FileSystem.FileSystem | Path.Path>) =>
  Effect.gen(function* () {
    const home = yield* tempDirectory("vibest-project-")
    const layout = Layer.succeed(Layout, yield* Layout.make(home))
    return yield* program.pipe(Effect.provide(Project.layer.pipe(Layer.provideMerge(layout))))
  })

describe("Project", () => {
  it.effect("info names the folder and its subfolders; search reads their text files", () =>
    withProject(
      Effect.gen(function* () {
        const project = yield* Project
        const layout = yield* Layout
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = layout.project(scope.id)
        const write = (rel: string, content: string) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(path.join(dir, rel)), { recursive: true })
            yield* fs.writeFileString(path.join(dir, rel), content)
          })
        yield* write("docs/b/deep.md", "---\ndescription: deep doc\n---\nNeedle here")
        yield* write("docs/a.txt", "first line\nno match")
        yield* write("artifacts/w1-notes.md", "needle in artifacts")
        // Not a text file vibest reads.
        yield* write("docs/skip.sh", "needle")

        assert.deepStrictEqual(yield* project.search(scope, { query: "NEEDLE" }), [
          "docs/b/deep.md:4: Needle here",
          "artifacts/w1-notes.md:1: needle in artifacts",
        ])
        assert.deepStrictEqual(yield* project.search(scope, { query: "needle", kind: "docs" }), [
          "docs/b/deep.md:4: Needle here",
        ])
        assert.deepStrictEqual(yield* project.info(scope), {
          directory: dir,
          instructions: path.join(dir, "instructions.md"),
          docs: path.join(dir, "docs"),
          memories: path.join(dir, "memories"),
          artifacts: layout.artifacts(scope.id),
        })
      }),
    ).pipe(Effect.provide(Platform.services)),
  )
})
