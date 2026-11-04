import { Layout } from "@vibest/core/paths"
import { ProjectInfoResult, ProjectKind, ProjectSearchInput } from "@vibest/schema/project"
// The project folder (SPEC §5.4): projects/<project id>/ holds instructions.md (the user edits it) and the fixed
// subfolders docs/, memories/ and artifacts/. Agents read and write them with their own file tools; vibestd only
// names the paths and searches the text.
import { Context, Effect, FileSystem, Layer, Path } from "effect"
export { ProjectInfoResult, ProjectKind, ProjectSearchInput } from "@vibest/schema/project"

const SEARCH_HITS = 50
const EXTENSIONS = [".md", ".txt", ".json", ".jsonl"]

const KINDS: ReadonlyArray<ProjectKind> = ["docs", "memories", "artifacts"]

/** Which Project. */
export interface ProjectScope {
  readonly id: string
}

export class Project extends Context.Service<
  Project,
  {
    readonly info: (scope: ProjectScope) => Effect.Effect<typeof ProjectInfoResult.Type>
    readonly search: (
      scope: ProjectScope,
      input: typeof ProjectSearchInput.Type,
    ) => Effect.Effect<ReadonlyArray<string>>
  }
>()("vibest/Project") {
  static readonly layer = Layer.effect(
    Project,
    Effect.gen(function* () {
      const layout = yield* Layout
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const dir = (scope: ProjectScope, kind: ProjectKind) => path.join(layout.project(scope.id), kind)

      const info = (scope: ProjectScope) =>
        Effect.succeed({
          directory: layout.project(scope.id),
          instructions: path.join(layout.project(scope.id), "instructions.md"),
          docs: dir(scope, "docs"),
          memories: dir(scope, "memories"),
          artifacts: dir(scope, "artifacts"),
        })

      // ponytail: reads every file per search; an index if projects grow past a few hundred files.
      const search = (scope: ProjectScope, input: typeof ProjectSearchInput.Type) =>
        Effect.gen(function* () {
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

      return Project.of({ info, search })
    }),
  )
}
