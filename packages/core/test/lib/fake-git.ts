import { Git, GitError, type GitState } from "@vibest/core/git"
import { NotInRepository } from "@vibest/schema/session"
import { Context, Effect, FileSystem, Layer, PlatformError } from "effect"

export interface RepositoryFacts {
  readonly branch?: string
  readonly origin?: string
  readonly uncommitted?: ReadonlyArray<string>
  readonly includes?: ReadonlyArray<string>
  readonly files?: Readonly<Record<string, string>>
  readonly copyFails?: string
  readonly addFails?: string
  readonly head?: string
  readonly commits?: ReadonlyArray<string>
}

export interface CheckoutFacts {
  readonly branch?: string
  readonly state?: GitState
  readonly stateError?: string
  readonly refuseRemove?: string
}

interface Checkout {
  facts: CheckoutFacts
}

interface Repository {
  readonly main: string
  facts: RepositoryFacts
  readonly checkouts: Map<string, Checkout>
}

interface Found {
  readonly repository: Repository
  readonly path: string
  readonly checkout: Checkout
}

export class FakeGit extends Context.Service<
  FakeGit,
  {
    readonly repository: (main: string, facts?: RepositoryFacts) => Effect.Effect<void>
    readonly update: (main: string, facts: RepositoryFacts) => Effect.Effect<void>
    readonly checkout: (path: string, facts: CheckoutFacts) => Effect.Effect<void>
    readonly git: Git.Interface
  }
>()("test/FakeGit") {
  static readonly layer = Layer.effect(
    FakeGit,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const repositories = new Map<string, Repository>()

      const real = (p: string) => fs.realPath(p).pipe(Effect.orElseSucceed(() => p))
      const locate = (dir: string) =>
        Effect.map(real(dir), (at) => {
          let best: Found | undefined
          for (const repository of repositories.values())
            for (const [path, checkout] of repository.checkouts)
              if ((at === path || at.startsWith(`${path}/`)) && (best === undefined || path.length > best.path.length))
                best = { repository, path, checkout }
          return best
        })
      const isDirectory = (p: string) =>
        fs.stat(p).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )
      const refused = (args: ReadonlyArray<string>, message: string) => new GitError({ args, message })
      const outside = (args: ReadonlyArray<string>, dir: string) =>
        refused(args, `fatal: not a git repository (or any of the parent directories): ${dir}`)
      const inRepository = (args: ReadonlyArray<string>, dir: string) =>
        Effect.flatMap(locate(dir), (found) =>
          found === undefined ? Effect.fail(outside(args, dir)) : Effect.succeed(found),
        )
      const branchOf = (found: Found) =>
        found.checkout.facts.branch ??
        (found.path === found.repository.main ? (found.repository.facts.branch ?? "main") : "")
      const register = (main: string, facts: RepositoryFacts) =>
        Effect.map(real(main), (at) => {
          repositories.set(at, { main: at, facts, checkouts: new Map([[at, { facts: {} }]]) })
        })
      const platform = (args: ReadonlyArray<string>) => (e: { readonly message: string }) => refused(args, e.message)
      const checkOut = (repository: Repository, into: string, args: ReadonlyArray<string>) =>
        Effect.forEach(
          Object.entries(repository.facts.files ?? {}),
          ([file, content]) => fs.writeFileString(`${into}/${file}`, content).pipe(Effect.mapError(platform(args))),
          { discard: true },
        )

      const git = Git.Service.of({
        mainCheckout: (dir) =>
          Effect.gen(function* () {
            const found = yield* locate(dir)
            if (found === undefined || !(yield* isDirectory(dir))) return yield* new NotInRepository({ path: dir })
            return found.repository.main
          }),
        topLevel: (dir) => Effect.map(inRepository(["rev-parse", "--show-toplevel"], dir), (found) => found.path),
        insideWorkTree: (dir) => Effect.map(locate(dir), (found) => found !== undefined),
        isMainCheckout: (dir) =>
          Effect.map(locate(dir), (found) => found !== undefined && found.path === found.repository.main),
        originUrl: (dir) => Effect.map(locate(dir), (found) => found?.repository.facts.origin),
        currentBranch: (dir) => Effect.map(inRepository(["branch", "--show-current"], dir), branchOf),
        uncommitted: (dir) =>
          Effect.map(inRepository(["status"], dir), (found) => found.repository.facts.uncommitted ?? []),
        copyRepository: ({ source, dest, branch, origin }) =>
          Effect.gen(function* () {
            const found = yield* inRepository(["clone"], source)
            if (found.repository.facts.copyFails !== undefined)
              return yield* refused(["clone"], found.repository.facts.copyFails)
            yield* fs.makeDirectory(dest).pipe(Effect.mapError(platform(["clone"])))
            yield* checkOut(found.repository, dest, ["clone"])
            yield* register(dest, {
              branch,
              ...(origin === undefined ? {} : { origin }),
              ...(found.repository.facts.files === undefined ? {} : { files: found.repository.facts.files }),
            })
          }),
        addWorktree: (root, path, commit) =>
          Effect.gen(function* () {
            const args = ["worktree", "add", "--detach", path, ...(commit === undefined ? [] : [commit])]
            const found = yield* inRepository(args, root)
            if (found.repository.facts.addFails !== undefined)
              return yield* refused(args, found.repository.facts.addFails)
            const taken =
              (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) &&
              (yield* fs.readDirectory(path).pipe(
                Effect.map((entries) => entries.length > 0),
                Effect.orElseSucceed(() => true),
              ))
            if (taken) return yield* refused(args, `fatal: '${path}' already exists`)
            yield* fs.makeDirectory(path, { recursive: true }).pipe(Effect.mapError(platform(args)))
            found.repository.checkouts.set(yield* real(path), { facts: {} })
            yield* checkOut(found.repository, path, args)
          }),
        head: (dir) =>
          Effect.flatMap(inRepository(["rev-parse", "HEAD"], dir), (found) =>
            found.repository.facts.head === undefined
              ? Effect.fail(refused(["rev-parse", "HEAD"], "fatal: ambiguous argument 'HEAD'"))
              : Effect.succeed(found.repository.facts.head),
          ),
        hasCommit: (dir, commit) =>
          Effect.map(locate(dir), (found) => found?.repository.facts.commits?.includes(commit) ?? false),
        removeWorktree: (root, path) =>
          Effect.gen(function* () {
            const args = ["worktree", "remove", path]
            const repository = (yield* locate(root))?.repository
            const at = yield* real(path)
            const checkout = repository?.checkouts.get(at)
            if (repository === undefined || checkout === undefined || at === repository.main)
              return yield* refused(args, `fatal: '${path}' is not a working tree`)
            if (checkout.facts.refuseRemove !== undefined) return yield* refused(args, checkout.facts.refuseRemove)
            repository.checkouts.delete(at)
            yield* fs.remove(path, { recursive: true }).pipe(Effect.ignore)
          }),
        linkedWorktrees: (root) =>
          Effect.map(locate(root), (found) =>
            found === undefined
              ? []
              : [...found.repository.checkouts.keys()].filter((path) => path !== found.repository.main),
          ),
        includedFiles: (root) => Effect.map(locate(root), (found) => found?.repository.facts.includes ?? []),
        ignored: (_cwd, paths) => Effect.succeed(paths),
        state: (worktree) =>
          Effect.gen(function* () {
            if (!(yield* isDirectory(worktree))) return undefined
            const found = yield* locate(worktree)
            if (found === undefined)
              return { branch: "", pushed: false, saved: false, why: "commits not on any branch" }
            if (found.checkout.facts.stateError !== undefined)
              return yield* Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "Git",
                  method: "state",
                  description: found.checkout.facts.stateError,
                }),
              )
            return found.checkout.facts.state ?? { branch: branchOf(found), pushed: false, saved: true, why: "" }
          }),
      })

      return FakeGit.of({
        repository: (main, facts = {}) => register(main, facts),
        update: (main, facts) =>
          Effect.map(locate(main), (found) => {
            if (found) found.repository.facts = { ...found.repository.facts, ...facts }
          }),
        checkout: (path, facts) =>
          Effect.map(locate(path), (found) => {
            if (found) found.checkout.facts = { ...found.checkout.facts, ...facts }
          }),
        git,
      })
    }),
  )

  static readonly git = Layer.effect(
    Git.Service,
    Effect.gen(function* () {
      return (yield* FakeGit).git
    }),
  )

  static readonly layers = FakeGit.git.pipe(Layer.provideMerge(FakeGit.layer))
}
