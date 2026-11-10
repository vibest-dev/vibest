import { assert, describe, it } from "@effect/vitest"
import { normalizeModels } from "@vibest/core/models"
import { Layout, shellQuote } from "@vibest/core/paths"
import { envelope, isUsageLimitError, outcome, parseReport } from "@vibest/core/results"
import { privateTmp, UserPlatform } from "@vibest/core/system-prompt"
import { ID, newId, shortId } from "@vibest/schema/id"
import { Cause, ConfigProvider, Effect, Exit, FileSystem } from "effect"

import * as Platform from "#platform"

import { tempDirectory } from "./fakes.ts"

describe("ids", () => {
  it.effect("a new id is a UUIDv4; one whose first 8 characters are taken is drawn again", () =>
    Effect.gen(function* () {
      assert.match(yield* newId(), ID)
      const asked: Array<string> = []
      const id = yield* newId((short) => Effect.sync(() => asked.push(short) < 3))
      assert.match(id, ID)
      assert.lengthOf(asked, 3)
      assert.strictEqual(shortId(id), asked[2])
      assert.strictEqual(shortId(id).length, 8)
    }),
  )
})

describe("System prompt directory", () => {
  const refused = <A, E, R>(e: Effect.Effect<A, E, R>) =>
    e.pipe(
      Effect.exit,
      Effect.map((exit) => {
        assert.isTrue(Exit.isFailure(exit))
        assert.match(String(Exit.isFailure(exit) && Cause.pretty(exit.cause)), /not a private directory/)
      }),
    )

  it.effect(
    "under TMPDIR: <TMPDIR>/vibest, made 0700; no TMPDIR: <parent>/vibest-<uid>, made 0700 and used again; a wrong mode, a symlink or another owner is refused",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmp = yield* tempDirectory("vibest-tmpdir-")
        assert.strictEqual(yield* privateTmp(tmp, "/nowhere"), `${tmp}/vibest`)
        assert.strictEqual((yield* fs.stat(`${tmp}/vibest`)).mode & 0o777, 0o700)
        const user = yield* UserPlatform
        const uid = user.uid!
        const parent = yield* tempDirectory("vibest-fallback-")
        const dir = `${parent}/vibest-${uid}`
        assert.strictEqual(yield* privateTmp("", parent), dir)
        assert.strictEqual((yield* fs.stat(dir)).mode & 0o777, 0o700)
        assert.strictEqual(yield* privateTmp("", parent), dir, "an existing private directory is used again")

        yield* fs.chmod(dir, 0o755)
        yield* refused(privateTmp("", parent))

        yield* fs.remove(dir, { recursive: true })
        const target = `${parent}/elsewhere`
        yield* fs.makeDirectory(target, { mode: 0o700 })
        yield* fs.symlink(target, dir)
        yield* refused(privateTmp("", parent))

        yield* fs.remove(dir)
        const asAnotherUid = { ...user, uid: uid + 1 }
        yield* refused(privateTmp("", parent).pipe(Effect.provideService(UserPlatform, asAnotherUid)))
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})

describe("envelope", () => {
  it("one element per field, empty ones left out, field text escaped and the agent's text kept as is", () => {
    assert.strictEqual(
      envelope(
        "agent-result",
        [
          ["agent-id", "a1b2c3d4-a1b2-4a1b-8a1b-a1b2c3d4a1b2"],
          ["summary", outcome('fix "x" <y>', undefined)],
          ["branch", ""],
        ],
        ["result", "a <b> & c"],
      ),
      '<agent-result>\n<agent-id>a1b2c3d4-a1b2-4a1b-8a1b-a1b2c3d4a1b2</agent-id>\n<summary>Agent "fix "x" &lt;y&gt;" finished</summary>\n<result>\na <b> & c\n</result>\n</agent-result>',
    )
    assert.strictEqual(outcome("t", "rate_limit"), 'Agent "t" failed: rate_limit')
    assert.isTrue(isUsageLimitError("rate_limit"))
    assert.isTrue(isUsageLimitError("rate_limit: hit the 5 hour limit"))
    assert.isTrue(isUsageLimitError("You've hit your usage limit"))
    assert.isTrue(isUsageLimitError("too many requests"))
    assert.isFalse(isUsageLimitError("model_not_found"))
    assert.isFalse(isUsageLimitError("model_not_found: usage limit"))
    assert.isFalse(isUsageLimitError("server_error: too many requests"))
    assert.isFalse(isUsageLimitError("server_error: the assistant said rate limit"))
    assert.isFalse(isUsageLimitError("aborted"))
    assert.isFalse(isUsageLimitError(undefined))
    assert.strictEqual(outcome("t", undefined), 'Agent "t" finished')
    assert.strictEqual(outcome("t", "boom"), 'Agent "t" failed: boom')
  })
})

describe("pure", () => {
  it.effect("~/.vibest layout: VIBEST_HOME, else $HOME/.vibest; the old product's OMO_HOME is not read", () =>
    Effect.gen(function* () {
      const layout = (env: Record<string, string>) =>
        Effect.gen(function* () {
          return yield* Layout
        }).pipe(
          Effect.provide(Layout.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          Effect.provide(Platform.services),
        )
      const withOmoHome = yield* layout({ HOME: "/h", OMO_HOME: "/old" })
      assert.deepInclude(withOmoHome, {
        home: "/h/.vibest",
        database: "/h/.vibest/vibest.db",
        socket: "/h/.vibest/vibest.sock",
        config: "/h/.vibest/vibest.json",
      })
      assert.strictEqual((yield* layout({ HOME: "/h", VIBEST_HOME: "/x" })).home, "/x")
    }),
  )

  it("summary is the first non-empty line cut to about 120 characters; the Remember section is still picked up", () => {
    const r = parseReport("\n  \nFixed it. Tests pass.\nmore\n\n## Remember\nuse bun\n\n## Other\nx")
    assert.deepStrictEqual(r, { summary: "Fixed it. Tests pass.", remember: "use bun" })
    assert.deepStrictEqual(parseReport(""), { summary: undefined, remember: undefined })
    const long = parseReport("x".repeat(200)).summary!
    assert.strictEqual(long.length, 120)
    assert.isTrue(long.endsWith("…"))
    assert.strictEqual(parseReport("status: needs_input\nwhich one?").summary, "status: needs_input")
  })

  it("normalizeModels: one Model shape, requested provider filled in, other providers dropped", () => {
    assert.deepStrictEqual(
      normalizeModels("pi", "azure", [
        { model: "gpt-5", description: "older", default: true },
        { model: "gpt-6", name: "GPT-6", default: false },
      ]),
      [
        { harness: "pi", provider: "azure", model: "gpt-5", name: "gpt-5", description: "older", default: true },
        { harness: "pi", provider: "azure", model: "gpt-6", name: "GPT-6", description: "", default: false },
      ],
    )
    const pi = [
      { provider: "xai", model: "grok", default: false },
      { provider: "zai", model: "grok", default: false },
    ]
    assert.deepStrictEqual(
      normalizeModels("pi", null, pi).map((m) => m.provider),
      ["xai", "zai"],
    )
    assert.deepStrictEqual(
      normalizeModels("pi", "zai", pi).map((m) => m.provider),
      ["zai"],
    )
  })

  it("shell quoting", () => {
    assert.strictEqual(shellQuote("/usr/bin/vibest"), "/usr/bin/vibest")
    assert.strictEqual(shellQuote("a b"), "'a b'")
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'")
    assert.strictEqual(shellQuote(""), "''")
  })
})
