import { Layout } from "@vibest/schema/layout"
import { ProjectInfoResult, ProjectKind, ProjectSearchInput } from "@vibest/schema/project"
import { Context, Effect, FileSystem, Layer, Path } from "effect"

import { LayerNode } from "./effect/layer-node.ts"
import { PlatformNode } from "./effect/platform.ts"

export * as Project from "./project.ts"

export { ProjectInfoResult, ProjectKind, ProjectSearchInput } from "@vibest/schema/project"

const SEARCH_HITS = 50
const EXTENSIONS = [".md", ".txt", ".json", ".jsonl"]

const KINDS: ReadonlyArray<ProjectKind> = ["docs", "memories", "artifacts"]

export interface ProjectScope {
  readonly id: string
}

export interface Interface {
  readonly info: (scope: ProjectScope) => Effect.Effect<typeof ProjectInfoResult.Type>
  readonly search: (scope: ProjectScope, input: typeof ProjectSearchInput.Type) => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("vibest/Project") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const layout = yield* Layout
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const dir = (scope: ProjectScope, kind: ProjectKind) => path.join(layout.project(scope.id), kind)

    const info = Effect.fn("Project.info")((scope: ProjectScope) =>
      Effect.succeed({
        directory: layout.project(scope.id),
        preferences: path.join(layout.project(scope.id), "preferences.md"),
        docs: dir(scope, "docs"),
        memories: dir(scope, "memories"),
        artifacts: dir(scope, "artifacts"),
      }),
    )

    const search = Effect.fn("Project.search")(function* (scope: ProjectScope, input: typeof ProjectSearchInput.Type) {
      const q = input.query.toLowerCase()
      const hits: string[] = []
      for (const kind of input.kind ? [input.kind] : KINDS) {
        const names = yield* fs
          .readDirectory(dir(scope, kind), { recursive: true })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        for (const name of names.filter((n) => EXTENSIONS.some((e) => n.endsWith(e))).sort()) {
          const content = yield* fs
            .readFileString(path.join(dir(scope, kind), name))
            .pipe(Effect.orElseSucceed(() => ""))
          const rel = name.split(path.sep).join("/")
          content.split("\n").forEach((l, i) => {
            if (hits.length < SEARCH_HITS && l.toLowerCase().includes(q))
              hits.push(`${kind}/${rel}:${i + 1}: ${l.trim().slice(0, 200)}`)
          })
        }
      }
      return hits
    })

    return Service.of({ info, search })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [PlatformNode.fileSystem, PlatformNode.layout, PlatformNode.path],
})
