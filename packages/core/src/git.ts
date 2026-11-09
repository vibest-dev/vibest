import { NotInRepository } from "@vibest/schema/session"
import { Context, Effect, FileSystem, Layer, Path, type PlatformError, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  args: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export interface GitState {
  readonly branch: string
  readonly pushed: boolean
  readonly saved: boolean
  readonly why: string
}

export interface RepositoryCopy {
  readonly source: string
  readonly dest: string
  readonly branch: string
  readonly origin: string | undefined
}

export class Git extends Context.Service<
  Git,
  {
    readonly mainCheckout: (dir: string) => Effect.Effect<string, NotInRepository>
    readonly topLevel: (dir: string) => Effect.Effect<string, GitError>
    readonly insideWorkTree: (dir: string) => Effect.Effect<boolean>
    readonly isMainCheckout: (dir: string) => Effect.Effect<boolean>
    readonly originUrl: (dir: string) => Effect.Effect<string | undefined>
    readonly currentBranch: (dir: string) => Effect.Effect<string, GitError>
    readonly uncommitted: (dir: string) => Effect.Effect<ReadonlyArray<string>, GitError>
    readonly copyRepository: (copy: RepositoryCopy) => Effect.Effect<void, GitError>
    readonly addWorktree: (root: string, path: string) => Effect.Effect<void, GitError>
    readonly removeWorktree: (root: string, path: string) => Effect.Effect<void, GitError>
    readonly linkedWorktrees: (root: string) => Effect.Effect<ReadonlyArray<string>>
    readonly includedFiles: (
      root: string,
    ) => Effect.Effect<ReadonlyArray<string>, GitError | PlatformError.PlatformError>
    readonly ignored: (cwd: string, paths: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, GitError>
    readonly state: (worktree: string) => Effect.Effect<GitState | undefined, PlatformError.PlatformError>
  }
>()("vibest/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const gitRaw = (cwd: string, args: ReadonlyArray<string>, input?: string, ok: ReadonlyArray<number> = [0]) =>
        Effect.gen(function* () {
          const stdin = input === undefined ? {} : { stdin: Stream.make(new TextEncoder().encode(input)) }
          const handle = yield* spawner.spawn(
            ChildProcess.make("git", ["--no-optional-locks", ...args], { cwd, ...stdin }),
          )
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          if (!ok.includes(exitCode)) return yield* new GitError({ args, message: stderr.trim() || `exit ${exitCode}` })
          return stdout
        }).pipe(
          Effect.scoped,
          Effect.catchTag("PlatformError", (e) => Effect.fail(new GitError({ args, message: e.message }))),
        )

      const git = (cwd: string, ...args: string[]) => gitRaw(cwd, args).pipe(Effect.map((out) => out.trim()))
      const tryGit = (cwd: string, ...args: string[]) => git(cwd, ...args).pipe(Effect.orElseSucceed(() => undefined))

      const gitDirectory = (p: string) =>
        fs.stat(p).pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "NotFound",
            () => Effect.succeed(undefined),
          ),
          Effect.map((info) => (info === undefined || info.type !== "Directory" ? undefined : p)),
        )

      const nul = (out: string) => out.split("\0").filter(Boolean)

      const ignored = (cwd: string, paths: ReadonlyArray<string>) =>
        paths.length === 0
          ? Effect.succeed([])
          : gitRaw(cwd, ["check-ignore", "-z", "--stdin"], paths.map((f) => `${f}\0`).join(""), [0, 1]).pipe(
              Effect.map(nul),
            )

      return Git.of({
        mainCheckout: Effect.fn("Git.mainCheckout")(function* (dir) {
          const cwd = yield* gitDirectory(dir).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)))
          if (cwd === undefined) return yield* new NotInRepository({ path: dir })
          const out = yield* git(
            dir,
            "rev-parse",
            "--path-format=absolute",
            "--show-toplevel",
            "--git-dir",
            "--git-common-dir",
          ).pipe(Effect.mapError(() => new NotInRepository({ path: dir })))
          const [top = "", gitDir, common = ""] = out.split("\n")
          return gitDir === common ? top : path.dirname(common)
        }),
        topLevel: (dir) => git(dir, "rev-parse", "--show-toplevel"),
        insideWorkTree: (dir) =>
          git(dir, "rev-parse", "--is-inside-work-tree").pipe(
            Effect.map((out) => out === "true"),
            Effect.orElseSucceed(() => false),
          ),
        isMainCheckout: (dir) =>
          git(dir, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir").pipe(
            Effect.map((out) => {
              const [gitDir, common = ""] = out.split("\n")
              return gitDir !== "" && gitDir === common
            }),
            Effect.orElseSucceed(() => false),
          ),
        originUrl: (dir) =>
          tryGit(dir, "config", "--get", "remote.origin.url").pipe(Effect.map((url) => url || undefined)),
        currentBranch: (dir) => git(dir, "branch", "--show-current"),
        uncommitted: (dir) =>
          git(dir, "status", "--porcelain", "--branch", "--untracked-files=all").pipe(
            Effect.map((status) => status.split("\n").slice(1).filter(Boolean)),
          ),
        copyRepository: Effect.fn("Git.copyRepository")(function* ({ source, dest, branch, origin }) {
          yield* git(source, "clone", "--quiet", "--no-hardlinks", "--branch", branch, "--", source, dest)
          yield* git(dest, "remote", "remove", "origin")
          if (origin === undefined) return
          yield* git(dest, "remote", "add", "origin", origin)
          yield* git(
            dest,
            "fetch",
            "--quiet",
            "--no-tags",
            "--",
            source,
            "+refs/remotes/origin/*:refs/remotes/origin/*",
            "^refs/remotes/origin/HEAD",
          )
          const head = yield* tryGit(source, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
          if (head?.startsWith("origin/"))
            yield* tryGit(dest, "remote", "set-head", "origin", head.slice("origin/".length))
          if ((yield* tryGit(source, "config", "--get", `branch.${branch}.remote`)) !== "origin") return
          const merge = yield* tryGit(source, "config", "--get", `branch.${branch}.merge`)
          if (!merge) return
          yield* git(dest, "config", `branch.${branch}.remote`, "origin")
          yield* git(dest, "config", `branch.${branch}.merge`, merge)
        }),
        addWorktree: (root, worktree) => git(root, "worktree", "add", "--detach", worktree).pipe(Effect.asVoid),
        removeWorktree: (root, worktree) => git(root, "worktree", "remove", worktree).pipe(Effect.asVoid),
        linkedWorktrees: (root) =>
          git(root, "worktree", "list", "--porcelain").pipe(
            Effect.orElseSucceed(() => ""),
            Effect.map((out) =>
              out
                .split("\n")
                .filter((line) => line.startsWith("worktree "))
                .slice(1)
                .map((line) => line.slice("worktree ".length)),
            ),
          ),
        includedFiles: Effect.fn("Git.includedFiles")(function* (root) {
          const include = path.join(root, ".worktreeinclude")
          if (!(yield* fs.exists(include))) return []
          const named = nul(
            yield* gitRaw(root, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${include}`]),
          ).filter((f) => !f.endsWith("/"))
          return yield* ignored(root, named)
        }),
        ignored,
        state: Effect.fn("Git.state")(function* (worktree) {
          if ((yield* gitDirectory(worktree)) === undefined) return undefined
          const branch = (yield* tryGit(worktree, "branch", "--show-current")) ?? ""
          const dirty = !!(yield* tryGit(worktree, "status", "--porcelain", "--untracked-files=all"))
          const contained =
            !!branch || !!(yield* tryGit(worktree, "for-each-ref", "--contains", "HEAD", "refs/heads", "refs/remotes"))
          const upstream = branch ? yield* tryGit(worktree, "rev-parse", "--abbrev-ref", "@{upstream}") : undefined
          const pushed = !!upstream && (yield* tryGit(worktree, "rev-list", "--count", "@{upstream}..HEAD")) === "0"
          const why = dirty ? "uncommitted changes" : !contained ? "commits not on any branch" : ""
          return { branch, pushed, saved: !why, why } satisfies GitState
        }),
      })
    }),
  )
}
