import { assert, layer } from "@effect/vitest"
import { copyIncluded } from "@vibest/core/worktree"
import { claude, cursor, pi } from "@vibest/plugin-harnesses"
import { FakeGit, harnessesLayer, makeRepository, tempDirectory } from "@vibest/server/test/lib/fakes"
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect"

import * as Platform from "#platform"

layer(Layer.mergeAll(FakeGit.layers.pipe(Layer.provideMerge(Platform.services)), harnessesLayer([pi, claude, cursor])))(
  "on the platform",
  (it) => {
    const addWorktree = (repo: string) =>
      Effect.gen(function* () {
        const wt = (yield* Path.Path).join(yield* tempDirectory("vibest-wt-"), "w")
        yield* (yield* FakeGit).git.addWorktree(repo, wt)
        return wt
      })
    const includes = (repo: string, files: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        yield* (yield* FakeGit).update(repo, { includes: files })
      })
    const write = (file: string, content: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory((yield* Path.Path).dirname(file), { recursive: true })
        yield* fs.writeFileString(file, content)
      })

    it.effect("copyIncluded: a selected symlink is recreated as the same link, never followed", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepository
        const outside = yield* tempDirectory("vibest-outside-")
        yield* includes(repo, [
          ".claude/skills/x/SKILL.md",
          ".claude/out.md",
          ".claude/dir-link",
          ".claude/dangling",
          ".claude/wt-link",
          ".claude/loop",
        ])
        yield* write(`${repo}/.claude/skills/x/SKILL.md`, "skill\n")
        yield* write(`${outside}/out.md`, "outside\n")
        const links: Record<string, string> = {
          "out.md": `${outside}/out.md`,
          "dir-link": "skills",
          dangling: "nowhere",
          "wt-link": "worktrees/sample",
          loop: "loop",
        }
        for (const [name, target] of Object.entries(links)) yield* fs.symlink(target, `${repo}/.claude/${name}`)
        const wt = yield* addWorktree(repo)
        assert.sameMembers(yield* copyIncluded(repo, wt), [
          ".claude/skills/x/SKILL.md",
          ...Object.keys(links).map((n) => `.claude/${n}`),
        ])
        for (const [name, target] of Object.entries(links))
          assert.strictEqual(yield* fs.readLink(`${wt}/.claude/${name}`), target, name)
      }),
    )

    it.effect("copyIncluded: a path already in the worktree, or under a link there, is left alone", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepository
        const outside = yield* tempDirectory("vibest-outside-")
        yield* includes(repo, ["a.json", ".claude/settings.local.json"])
        yield* write(`${repo}/a.json`, "main\n")
        yield* write(`${repo}/.claude/settings.local.json`, "{}\n")
        const wt = yield* addWorktree(repo)
        yield* write(`${wt}/a.json`, "the worktree's own\n")
        yield* fs.symlink(outside, `${wt}/.claude`)
        assert.deepStrictEqual(yield* copyIncluded(repo, wt), [])
        assert.strictEqual(yield* fs.readFileString(`${wt}/a.json`), "the worktree's own\n")
        assert.deepStrictEqual(yield* fs.readDirectory(outside), [])
      }),
    )

    it.effect(
      "copyIncluded: a readLink that fails with EACCES or EIO, on the source or on a directory above the destination, fails the copy and writes nothing",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const repo = yield* makeRepository
          yield* includes(repo, [".claude/settings.local.json"])
          yield* write(`${repo}/.claude/settings.local.json`, "{}\n")
          for (const code of ["EACCES", "EIO"]) {
            for (const at of ["source", "destination parent"] as const) {
              const wt = yield* addWorktree(repo)
              yield* fs.makeDirectory(`${wt}/.claude`)
              const src = `${repo}/.claude/settings.local.json`
              const dst = `${wt}/.claude/settings.local.json`
              const failing = at === "source" ? src : `${wt}/.claude`
              const writes: Array<string> = []
              const faulty = Layer.succeed(FileSystem.FileSystem, {
                ...fs,
                readLink: (p: string) =>
                  p === failing
                    ? Effect.fail(
                        PlatformError.systemError({
                          _tag: code === "EACCES" ? "PermissionDenied" : "Unknown",
                          module: "FileSystem",
                          method: "readLink",
                          pathOrDescriptor: p,
                          cause: Object.assign(new Error(code), { code }),
                        }),
                      )
                    : fs.readLink(p),
                copyFile: (from: string, to: string) =>
                  Effect.sync(() => writes.push(to)).pipe(Effect.andThen(fs.copyFile(from, to))),
                symlink: (target: string, p: string) =>
                  Effect.sync(() => writes.push(p)).pipe(Effect.andThen(fs.symlink(target, p))),
              })
              const error = yield* Effect.flip(copyIncluded(repo, wt).pipe(Effect.provide(faulty)))
              assert.strictEqual(error._tag, "CopyFailed", `${code} ${at}`)
              assert.deepInclude(error, { source: src, destination: dst })
              assert.include(error.message, `copy ${src} -> ${dst}: `)
              assert.include(error.message, `FileSystem.readLink (${failing})`)
              assert.match(error.message, new RegExp(`\\(${code}\\)$`))
              assert.deepStrictEqual(writes, [], `${code} ${at}`)
              assert.isFalse(yield* fs.exists(dst))
            }
          }
        }),
    )
  },
)
