import { Database } from "bun:sqlite"

import { assert, layer } from "@effect/vitest"
import { projectActivity, raisesSeen, unseenDone } from "@vibest/core/activity"
import { Db } from "@vibest/core/db"
import { Harness, Harnesses, HarnessUnavailable, harnessCatalog, harnessOptions, preflight } from "@vibest/core/harness"
import * as Launch from "@vibest/core/launch"
import { forProvider, listModels } from "@vibest/core/models"
import { caseFoldedWorktrees, Layout, VibestCommand, safeRepositoryDirectory } from "@vibest/core/paths"
import { locateProject, resolveProject } from "@vibest/core/project-identity"
import { executionEndFrom, executionEndOf } from "@vibest/core/replies"
import { copyIncluded, mainCheckout, repositoryDirectoryName } from "@vibest/core/worktree"
import { claude, cursor, pi } from "@vibest/plugin-harnesses"
import { noProvider } from "@vibest/plugin-harnesses/models"
import type { HarnessChoice } from "@vibest/protocol/rpc"
import { ID } from "@vibest/schema/id"
import { ConfigProvider, Effect, FileSystem, Layer, Path, PlatformError, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

import { FakeGit, harnessesLayer, makeRepository, tempDirectory } from "./fakes.ts"
import { database } from "./unit-helpers.ts"

layer(Layer.mergeAll(FakeGit.layers.pipe(Layer.provideMerge(Platform.services)), harnessesLayer([pi, claude, cursor])))(
  "on the platform",
  (it) => {
    it.effect("model listings run in the user's home, not the caller's working directory", () =>
      Effect.gen(function* () {
        const home = yield* tempDirectory("model-home-")
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${home}/Library/Keychains`, { recursive: true })
        yield* fs.writeFileString(`${home}/Library/Keychains/login.keychain-db`, "fake keychain; no real CLI")
        const cwds: Array<string | undefined> = []
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.suspend(() => {
            if (command._tag === "StandardCommand") {
              cwds.push(command.options.cwd)
              assert.strictEqual(command.options.env?.HOME, home)
              assert.strictEqual(command.options.extendEnv, true)
            }
            return Effect.fail(PlatformError.badArgument({ module: "test", method: "spawn" }))
          }),
        )
        yield* Effect.gen(function* () {
          const harness = yield* Harness.make()
          yield* Effect.flip(harness.models("pi", null))
          const adapters = yield* Harnesses
          yield* Effect.forEach(["claude", "cursor"] as const, (h) =>
            adapters.get(h).pipe(Effect.flatMap((adapter) => Effect.flip(listModels(adapter, null)))),
          )
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ HOME: home }), { asPrimary: true })),
        )
        assert.notStrictEqual(process.cwd(), home)
        assert.deepStrictEqual(cwds, [home, home, home])
      }),
    )

    it.effect("a model list is reused, and a failed lookup is not", () =>
      Effect.gen(function* () {
        const piLines = [
          JSON.stringify({
            id: "vibest-state",
            type: "response",
            data: { model: { provider: "openai", id: "gpt" } },
          }),
          JSON.stringify({
            id: "vibest-models",
            type: "response",
            data: {
              models: [{ provider: "openai", id: "gpt", name: "GPT", contextWindow: 1, maxTokens: 1 }],
            },
          }),
        ].join("\n")
        const handle = () =>
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.make(new TextEncoder().encode(piLines)),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          })
        let calls = 0
        const harness = yield* Harness.make().pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => {
              calls++
              return Effect.succeed(handle())
            }),
          ),
        )
        const first = yield* harness.models("pi", null)
        assert.deepStrictEqual(yield* harness.models("pi", null), first)
        assert.strictEqual(calls, 1)
        assert.strictEqual(first[0]?.model, "gpt")

        let failed = 0
        const again = yield* Harness.make().pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => {
              failed++
              return Effect.fail(PlatformError.badArgument({ module: "test", method: "spawn" }))
            }),
          ),
        )
        yield* Effect.flip(again.models("pi", null))
        yield* Effect.flip(again.models("pi", null))
        assert.strictEqual(failed, 2)
      }),
    )

    it.effect("model discovery for a run overlays that run's env, and a different env is not cached", () =>
      Effect.gen(function* () {
        const piLines = [
          JSON.stringify({
            id: "vibest-state",
            type: "response",
            data: { model: { provider: "openai", id: "gpt" } },
          }),
          JSON.stringify({
            id: "vibest-models",
            type: "response",
            data: {
              models: [{ provider: "openai", id: "gpt", name: "GPT", contextWindow: 1, maxTokens: 1 }],
            },
          }),
        ].join("\n")
        const seen: Array<{ readonly dir?: string | undefined; readonly home?: string | undefined }> = []
        const harness = yield* Harness.make().pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              if (command._tag === "StandardCommand") {
                assert.strictEqual(command.options.extendEnv, true)
                seen.push({ dir: command.options.env?.PI_CODING_AGENT_DIR, home: command.options.env?.HOME })
              }
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(1),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: Stream.empty,
                  stderr: Stream.empty,
                  all: Stream.make(new TextEncoder().encode(piLines)),
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              )
            }),
          ),
        )
        const daemon = yield* harness.models("pi", null)
        const run = { PI_CODING_AGENT_DIR: "/run/pi", HOME: "/run/home" }
        const overlaid = yield* harness.models("pi", null, run)
        assert.deepStrictEqual(
          yield* harness.models("pi", null, { HOME: "/run/home", PI_CODING_AGENT_DIR: "/run/pi" }),
          overlaid,
        )
        yield* harness.models("pi", null, { PI_CODING_AGENT_DIR: "/other" })
        assert.strictEqual(daemon[0]?.model, "gpt")
        assert.deepStrictEqual(seen, [
          { dir: undefined, home: seen[0]?.home },
          { dir: "/run/pi", home: "/run/home" },
          { dir: "/other", home: seen[0]?.home },
        ])
      }),
    )

    it.effect("preflight discovers models with the run's env", () =>
      Effect.gen(function* () {
        let seen: Readonly<Record<string, string>> | undefined
        const models = yield* preflight("pi", null, "gpt", { PI_CODING_AGENT_DIR: "/run/pi" }).pipe(
          Effect.provide(
            Layer.succeed(Harness, {
              available: () => Effect.succeed(true),
              plugin: () => Effect.succeed("/plugin/pi"),
              models: (_id, _provider, env) => {
                seen = env
                return Effect.succeed([
                  { harness: "pi", provider: "openai", model: "gpt", name: "GPT", description: "", default: true },
                ])
              },
            }),
          ),
        )
        assert.strictEqual(models[0]?.model, "gpt")
        assert.deepStrictEqual(seen, { PI_CODING_AGENT_DIR: "/run/pi" })
      }),
    )

    it.effect("Cursor discovery refuses missing and empty Keychains directories on macOS", () =>
      Effect.gen(function* () {
        if (process.platform !== "darwin") return
        const home = yield* tempDirectory("cursor-home-")
        const commands: Array<string> = []
        const spawner = ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand") commands.push(command.command)
          return Effect.fail(PlatformError.badArgument({ module: "test", method: "spawn" }))
        })
        const check = Effect.gen(function* () {
          const harness = yield* Harness.make()
          const error = yield* Effect.flip(harness.models("cursor", null))
          assert.include(error.message, "Library/Keychains")
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ HOME: home }), { asPrimary: true })),
        )
        yield* check
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${home}/Library/Keychains`, { recursive: true })
        yield* check
        assert.deepStrictEqual(commands, [])
      }),
    )

    it.effect("preflight names model discovery and keeps the native cause", () =>
      Effect.gen(function* () {
        const reported = (cause: string) =>
          preflight("cursor", null, null).pipe(
            Effect.flip,
            Effect.provide(
              Layer.succeed(Harness, {
                available: () => Effect.succeed(true),
                plugin: (id) => Effect.succeed(`/vibest/harnesses/${id}`),
                models: () => Effect.fail(new HarnessUnavailable({ harness: "cursor", message: cause })),
              }),
            ),
            Effect.map((e) => e.message),
          )
        const keychain = "cursor-agent gave no model list: Run `security unlock-keychain` and try again."
        const query = "cursor-agent did not list its models: spawn ENOENT"
        const auth = "cursor-agent gave no model list: Not logged in"
        assert.strictEqual(yield* reported(keychain), `cursor model discovery failed: ${keychain}`)
        assert.strictEqual(yield* reported(query), `cursor model discovery failed: ${query}`)
        assert.strictEqual(yield* reported(auth), `cursor model discovery failed: ${auth}`)
      }),
    )

    it("a project shows what needs the user most: blocked, then an unseen done, then working, else idle", () => {
      assert.strictEqual(projectActivity(["idle", "working", "done", "blocked"]), "blocked")
      assert.strictEqual(projectActivity(["working", "done", "idle"]), "done")
      assert.strictEqual(projectActivity(["idle", "working", "unknown"]), "working")
      assert.strictEqual(projectActivity(["idle", "unknown"]), "idle")
      assert.strictEqual(projectActivity([]), "idle")
    })

    it("an idle session is done only while its finished count is past the mark; no mark (or no runtime support) is never done", () => {
      assert.strictEqual(unseenDone("idle", { finished: 3, seen: 2 }), "done")
      assert.strictEqual(unseenDone("idle", { finished: 3, seen: 3 }), "idle")
      assert.strictEqual(unseenDone("idle", { finished: 3, seen: null }), "idle")
      assert.strictEqual(unseenDone("idle", undefined), "idle")
      assert.strictEqual(unseenDone("working", { finished: 3, seen: 0 }), "working")
      assert.strictEqual(unseenDone("blocked", { finished: 3, seen: 0 }), "blocked")
    })

    it("the seen mark only rises, never past the count the runtime finished; a missing mark may be set", () => {
      assert.isTrue(raisesSeen({ finished: 3, seen: 2 }, 3))
      assert.isFalse(raisesSeen({ finished: 3, seen: 3 }, 3))
      assert.isFalse(raisesSeen({ finished: 3, seen: 2 }, 1))
      assert.isFalse(raisesSeen({ finished: 3, seen: 2 }, 4))
      assert.isFalse(raisesSeen({ finished: 3, seen: 2 }, 2.5))
      assert.isTrue(raisesSeen({ finished: 3, seen: null }, 0))
      assert.isFalse(raisesSeen({ finished: 3, seen: null }, -1))
      assert.isFalse(raisesSeen({ finished: 3, seen: null }, 1.5))
    })

    it("models --provider: only Pi filters by provider; Claude and Cursor refuse any provider and keep provider null", () => {
      const definitions = {
        find: (id: string) => ({ checkProvider: id === "pi" ? () => undefined : noProvider(id) }),
      }
      const choices: ReadonlyArray<HarnessChoice> = [
        {
          harness: "claude",
          binary: "claude",
          problem: null,
          models: [{ provider: null, model: "opus", name: "Opus", default: true }],
        },
        {
          harness: "pi",
          binary: "pi",
          problem: null,
          models: [
            { provider: "openai", model: "gpt", name: "GPT", default: true },
            { provider: "anthropic", model: "sonnet", name: "Sonnet", default: false },
          ],
        },
      ]
      assert.deepStrictEqual(forProvider(choices, definitions, "anthropic"), [
        { harness: "claude", binary: "claude", problem: "claude has no provider option", models: [] },
        {
          harness: "pi",
          binary: "pi",
          problem: null,
          models: [{ provider: "anthropic", model: "sonnet", name: "Sonnet", default: false }],
        },
      ])
      assert.deepStrictEqual(
        forProvider(choices, definitions, "google").map((c) => c.problem),
        ["claude has no provider option", 'pi lists no models for provider "google"'],
      )
      assert.strictEqual(noProvider("cursor")("anthropic"), "cursor has no provider option")
      assert.isUndefined(noProvider("cursor")(null))
    })

    it.effect("the harness catalog and the start options agree: a harness off PATH has a problem and no models", () =>
      Effect.gen(function* () {
        const [catalog, options] = yield* Effect.all([harnessCatalog, harnessOptions]).pipe(
          Effect.provide(
            Layer.succeed(Harness, {
              available: (id) => Effect.succeed(id !== "cursor"),
              plugin: (id) => Effect.succeed(`/vibest/harnesses/${id}`),
              models: (id) =>
                Effect.succeed([
                  { harness: id, provider: "p", model: `${id}-1`, name: "One", description: "d", default: true },
                ]),
            }),
          ),
        )
        assert.deepStrictEqual(
          catalog.find((c) => c.harness === "pi"),
          {
            harness: "pi",
            binary: "pi",
            problem: null,
            models: [{ provider: "p", model: "pi-1", name: "One", default: true }],
          },
        )
        assert.deepStrictEqual(
          catalog.find((c) => c.harness === "cursor"),
          {
            harness: "cursor",
            binary: "cursor-agent",
            problem: "cursor-agent is not on PATH",
            models: [],
          },
        )
        assert.deepStrictEqual(
          options,
          catalog.map((c) =>
            c.problem === null
              ? { harness: c.harness, available: true }
              : { harness: c.harness, available: false, problem: c.problem },
          ),
        )
      }),
    )

    it.effect(
      "execution ends: reply field per harness; error fails, aborted interrupts; a junk hook input is no execution end",
      () =>
        Effect.gen(function* () {
          const harnesses = yield* Harnesses
          assert.deepInclude(executionEndFrom(yield* harnesses.get("claude"), { last_assistant_message: "hi" }, 5), {
            harness: "claude",
            at: 5,
            status: "completed",
            reply: "hi",
            failure: undefined,
            needsReady: true,
          })
          assert.deepInclude(
            executionEndFrom(yield* harnesses.get("pi"), { text: "", error: "boom", error_details: "why" }, 1),
            { status: "failed", failure: "boom: why", limited: false },
          )
          assert.deepInclude(executionEndFrom(yield* harnesses.get("pi"), { text: "", error: "rate limit hit" }, 1), {
            status: "failed",
            limited: true,
          })
          assert.deepInclude(
            executionEndFrom(yield* harnesses.get("pi"), { text: "so far", error: "aborted", aborted: true }, 1),
            { status: "interrupted", reply: "so far", failure: undefined },
          )
          assert.deepInclude(
            executionEndFrom(yield* harnesses.get("cursor"), { text: "x", conversation_id: "c-1" }, 1),
            {
              conversation: "c-1",
              needsReady: false,
            },
          )
          for (const bad of ["--flag", "-f", "--yolo", "--force", "a b", ""])
            assert.deepInclude(
              executionEndFrom(yield* harnesses.get("cursor"), { text: "x", conversation_id: bad }, 1),
              {
                conversation: undefined,
              },
            )
          assert.isUndefined(executionEndOf(yield* harnesses.get("claude"), "general", "{", 1))
        }),
    )

    it.effect(
      "a project is found by the realpath of its directory or of one of its repositories, origin kept as git prints it",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const file = path.join(yield* tempDirectory("vibest-identity-"), "vibest.db")
          const repositories = (id: string) => {
            const reader = new Database(file, { readonly: true })
            const rows = reader
              .query("SELECT path, remote_url AS remote FROM project_repository WHERE project_id = ? ORDER BY path")
              .all(id)
            reader.close()
            return rows
          }
          yield* Effect.gen(function* () {
            const db = yield* Db
            const resolve = (directory: string) =>
              Effect.flatMap(locateProject(directory), (located) => resolveProject(db, located))
            const repo = yield* makeRepository
            const first = yield* resolve(repo)
            assert.match(first.id, ID)
            assert.strictEqual(first.directory, repo)
            assert.deepStrictEqual(yield* resolve(repo), first)
            const link = path.join(yield* tempDirectory("vibest-link-"), "l")
            yield* fs.symlink(repo, link)
            assert.deepStrictEqual(yield* resolve(link), first)
            const wt = path.join(yield* tempDirectory("vibest-wt-"), "w")
            const fakeGit = yield* FakeGit
            yield* fakeGit.git.addWorktree(repo, wt)
            assert.deepStrictEqual(yield* resolve(wt), first)
            assert.deepStrictEqual(repositories(first.id), [{ path: repo, remote: null }])
            yield* fakeGit.update(repo, { origin: "git@github.com:A/b.git" })
            yield* resolve(repo)
            assert.deepStrictEqual(repositories(first.id), [{ path: repo, remote: "git@github.com:A/b.git" }])
            yield* fakeGit.update(repo, { origin: "https://github.com/A/b.git" })
            yield* resolve(wt)
            assert.deepStrictEqual(repositories(first.id), [{ path: repo, remote: "https://github.com/A/b.git" }])
            const clone = path.join(yield* tempDirectory("vibest-clone-"), "c")
            yield* fs.makeDirectory(clone)
            yield* fakeGit.repository(clone, { origin: "https://github.com/A/b.git" })
            assert.notStrictEqual((yield* resolve(clone)).id, first.id)
            const parent = yield* tempDirectory("vibest-multi-")
            for (const name of ["app", "sdk"]) {
              const child = path.join(parent, name)
              yield* fs.makeDirectory(child)
              yield* fakeGit.repository(child)
            }
            const multi = yield* resolve(parent)
            assert.strictEqual(multi.directory, parent)
            assert.deepStrictEqual(
              repositories(multi.id).map((row) => (row as { path: string }).path),
              [path.join(parent, "app"), path.join(parent, "sdk")],
            )
            assert.deepStrictEqual(yield* resolve(path.join(parent, "app")), multi)
            assert.isUndefined(yield* db.projectAt(yield* tempDirectory("vibest-none-")))
          }).pipe(
            Effect.provide(database(file)),
            Effect.provide(Layer.effect(Layout, Layout.make(path.join(path.dirname(file), "home")))),
          )
        }).pipe(Effect.provide(Platform.services)),
    )

    it.effect("repository directory name is the remote's own name, or the main checkout's, not the key", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const repo = yield* makeRepository
        const base = path.basename(repo)
        yield* fs.makeDirectory(path.join(repo, "pkg"))
        assert.strictEqual(yield* repositoryDirectoryName(path.join(repo, "pkg")), base)
        assert.notStrictEqual(base, "pkg")
        const fakeGit = yield* FakeGit
        yield* fakeGit.update(repo, { origin: "git@github.com:Org/MyRepo.git" })
        assert.strictEqual(yield* repositoryDirectoryName(path.join(repo, "pkg")), "MyRepo")
        yield* fakeGit.update(repo, { origin: "https://example.com/Repo.git/" })
        assert.strictEqual(yield* repositoryDirectoryName(repo), "Repo")
        assert.isTrue(safeRepositoryDirectory("MyRepo"))
        assert.isTrue(safeRepositoryDirectory("pi-orchestrator"))
        assert.isFalse(safeRepositoryDirectory("abcd1234-abcd-4abc-8abc-abcd1234abcd"))
        assert.strictEqual(safeRepositoryDirectory("ABCD1234"), !caseFoldedWorktrees)
        assert.isFalse(safeRepositoryDirectory(".."))
        assert.isFalse(safeRepositoryDirectory("a/b"))
        assert.isFalse(safeRepositoryDirectory(""))
      }),
    )

    it.effect(
      "vibest: the main checkout from anywhere inside, linked worktrees included; the entry session's command and env; a refused launch never asks for the session",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const repo = yield* makeRepository
          const home = yield* tempDirectory("vibest-home-")
          assert.strictEqual(yield* mainCheckout(repo), repo)
          yield* fs.makeDirectory(path.join(repo, "sub"))
          assert.strictEqual(yield* mainCheckout(path.join(repo, "sub")), repo)
          const linked = path.join(yield* tempDirectory("vibest-linked-"), "wt")
          yield* (yield* FakeGit).git.addWorktree(repo, linked)
          assert.strictEqual(yield* mainCheckout(linked), repo)
          assert.strictEqual((yield* Effect.flip(mainCheckout(home)))._tag, "NotInRepository")

          const harness = Layer.succeed(Harness, {
            available: () => Effect.succeed(true),
            plugin: (id) =>
              id === "pi"
                ? Effect.fail(new HarnessUnavailable({ harness: id, message: "vibest's pi plugin is missing: /x/pi" }))
                : Effect.succeed(`/x/${id}`),
            models: () => Effect.succeed([]),
          })
          const claudeDir = yield* tempDirectory("vibest-claude-")
          const tmp = yield* tempDirectory("vibest-tmp-")
          const PROJECT = "0e0e0000-0e0e-40e0-80e0-0e0e00000e0e"
          const run = (
            h: "claude" | "pi" | "cursor",
            harnessSessionId: string | null = null,
            sessionId = "",
            session: Effect.Effect<{
              sessionId: string
              harnessSessionId: string | null
              projectId: string
              runtime?: string
            }> = Effect.succeed({ sessionId, harnessSessionId, projectId: PROJECT }),
            provider: string | null = null,
          ) =>
            Launch.entryCommand({
              harness: h,
              root: repo,
              provider,
              model: null,
              session,
            }).pipe(
              Effect.provide(harness),
              Effect.provide(
                ConfigProvider.layerAdd(
                  ConfigProvider.fromUnknown({
                    CLAUDE_CONFIG_DIR: claudeDir,
                    TMPDIR: tmp,
                    HERDR_PANE_ID: "w1:p1",
                    HERDR_SOCKET_PATH: "/h/herdr.sock",
                  }),
                  { asPrimary: true },
                ),
              ),
              Effect.provide(Layer.effect(Layout, Layout.make(home))),
              Effect.provideService(VibestCommand, ["/bin/vibest"]),
            )
          assert.strictEqual((yield* run("claude")).file, "claude")
          const launched = yield* run("claude", null, "abcd1234-abcd-4abc-8abc-abcd1234abcd")
          assert.strictEqual(launched.env.VIBEST_SESSION_ID, "abcd1234-abcd-4abc-8abc-abcd1234abcd")
          const placed = yield* run(
            "claude",
            null,
            "abcd1234-abcd-4abc-8abc-abcd1234abcd",
            Effect.succeed({
              sessionId: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
              harnessSessionId: null,
              projectId: "07e40000-07e4-407e-807e-07e4000007e4",
              runtime: '{"runtime":"herdr"}',
            }),
          )
          assert.strictEqual(placed.env.VIBEST_PROJECT_ID, "07e40000-07e4-407e-807e-07e4000007e4")
          assert.strictEqual(placed.env.VIBEST_RUNTIME, '{"runtime":"herdr"}')
          assert.deepStrictEqual(
            (yield* run("claude", "s1", "abcd1234-abcd-4abc-8abc-abcd1234abcd")).args.slice(0, 2),
            ["--resume", "s1"],
          )
          let asked = 0
          const counted = Effect.sync(
            () => (
              asked++,
              { sessionId: "abcd1234-abcd-4abc-8abc-abcd1234abcd", harnessSessionId: null, projectId: PROJECT }
            ),
          )
          assert.strictEqual((yield* Effect.flip(run("cursor", null, "", counted)))._tag, "HarnessUnavailable")
          assert.include((yield* Effect.flip(run("pi", null, "", counted))).message, "vibest's pi plugin is missing")
          assert.strictEqual(
            (yield* Effect.flip(run("claude", null, "", counted, "openai")))._tag,
            "HarnessUnavailable",
          )
          assert.strictEqual(asked, 0)
        }),
    )

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

    it.effect("copyIncluded: a failed check names source, destination and errno, before anything is copied", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const repo = yield* makeRepository
        yield* includes(repo, ["a.json", "cfg/x"])
        yield* write(`${repo}/cfg/x`, "x\n")
        yield* write(`${repo}/a.json`, "{}\n")
        const wt = yield* addWorktree(repo)
        yield* write(`${wt}/cfg`, "a tracked file, checked out\n")
        const error = yield* Effect.flip(copyIncluded(repo, wt))
        assert.strictEqual(error._tag, "CopyFailed")
        assert.include(error.message, `copy ${repo}/cfg/x -> ${wt}/cfg/x: `)
        assert.match(error.message, /\(ENOTDIR\)$/)
        assert.isFalse(yield* fs.exists(`${wt}/a.json`))
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
