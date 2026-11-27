import { Layout } from "@vibest/schema/layout"
import { ProjectInfoResult, ProjectKind, ProjectSearchInput } from "@vibest/schema/project"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, FileSystem, Layer, Path } from "effect"

import { PlatformNode } from "./effect/platform.ts"
import { listProjectRepositories } from "./project/create.ts"
import { RepositoryUrl, repositoryIdentity } from "./project/repository-url.ts"
import { Git } from "./worktree/git.ts"

export * as Project from "./project.ts"

export { ProjectStore } from "./project/store.ts"

export { ProjectInfoResult, ProjectKind, ProjectSearchInput } from "@vibest/schema/project"

const SEARCH_HITS = 50
const EXTENSIONS = [".md", ".txt", ".json", ".jsonl"]

const KINDS: ReadonlyArray<ProjectKind> = ["docs", "memories", "artifacts"]

export interface ProjectScope {
  readonly id: string
}

export interface RecordedRepository {
  readonly path: string
  readonly remote: string | null
}

export interface RepositoryIdentityEntry {
  readonly path: string
  readonly identity: string | null
}

export interface Interface {
  readonly info: (scope: ProjectScope) => Effect.Effect<typeof ProjectInfoResult.Type>
  readonly search: (scope: ProjectScope, input: typeof ProjectSearchInput.Type) => Effect.Effect<ReadonlyArray<string>>
  readonly repositories: (
    directory: string | null,
    recorded?: ReadonlyArray<RecordedRepository>,
  ) => Effect.Effect<ReadonlyArray<RepositoryIdentityEntry>>
}

export class Service extends Context.Service<Service, Interface>()("vibest/Project") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const layout = yield* Layout
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const git = yield* Git.Service
    const repositoryUrl = yield* RepositoryUrl.Service

    const dir = (scope: ProjectScope, kind: ProjectKind) => path.join(layout.project(scope.id), kind)
    const real = (p: string) => fs.realPath(p).pipe(Effect.orElseSucceed(() => p))

    const identityOf = (url: string) =>
      repositoryIdentity(url).pipe(Effect.provideService(RepositoryUrl.Service, repositoryUrl))

    const livePaths = (directory: string) =>
      Effect.gen(function* () {
        const root = yield* git.mainCheckout(directory).pipe(
          Effect.flatMap(real),
          Effect.orElseSucceed(() => undefined),
        )

        if (root !== undefined) return [root]

        const children = yield* listProjectRepositories(directory).pipe(
          Effect.provideService(Git.Service, git),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.orElseSucceed(() => undefined),
        )

        if (children === undefined || children.length === 0) return undefined

        const paths = yield* Effect.forEach(
          children,
          (child) =>
            git.mainCheckout(child.path).pipe(
              Effect.flatMap(real),
              Effect.catch(() => real(child.path)),
            ),
          { concurrency: 8 },
        )

        return [...new Set(paths)].sort()
      })

    const repositories = Effect.fn("Project.repositories")(function* (
      directory: string | null,
      recorded: ReadonlyArray<RecordedRepository> = [],
    ) {
      const paths = directory === null ? undefined : yield* livePaths(directory)

      if (paths !== undefined) {
        return yield* Effect.forEach(
          paths,
          (repoPath) =>
            Effect.gen(function* () {
              const url = yield* git.remoteUrl(repoPath, "project")
              const identity = url === undefined ? undefined : yield* identityOf(url)

              return { path: repoPath, identity: identity ?? null } satisfies RepositoryIdentityEntry
            }),
          { concurrency: 8 },
        )
      }

      return yield* Effect.forEach(
        recorded,
        (entry) =>
          Effect.gen(function* () {
            const stored = entry.remote === null ? undefined : yield* identityOf(entry.remote)

            if (stored !== undefined) return { path: entry.path, identity: stored } satisfies RepositoryIdentityEntry

            const url = yield* git.remoteUrl(entry.path, "project")
            const identity = url === undefined ? undefined : yield* identityOf(url)

            return { path: entry.path, identity: identity ?? null } satisfies RepositoryIdentityEntry
          }),
        { concurrency: 8 },
      )
    })

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

    return Service.of({ info, search, repositories })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Git.node, RepositoryUrl.node, PlatformNode.fileSystem, PlatformNode.layout, PlatformNode.path],
})
