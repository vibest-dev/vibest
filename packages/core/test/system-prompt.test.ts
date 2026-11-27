import { assert, describe, it } from "@effect/vitest"
import { configuredMcpServers, projectText, systemPrompt } from "@vibest/core/session/system-prompt"
import * as Platform from "@vibest/testkit/bun"
import { tempDirectory } from "@vibest/testkit/directory"
import { Deferred, Effect, Fiber, FileSystem, Path } from "effect"

const promptOf = (dir: string, text: { preferences: string; memories: string }) =>
  systemPrompt({ system: "You are an agent.\n", id: "a", projectDir: dir, agents: [], ...text })

const facts = (extra: Partial<Parameters<typeof systemPrompt>[0]>) =>
  systemPrompt({
    system: "BODY\n",
    id: "a",
    projectDir: "/p",
    preferences: "",
    memories: "",
    agents: [],
    ...extra,
  })

describe("systemPrompt: the definition body first, then facts that name the channel to use", () => {
  it("a session the user opened has no one to send its report to and works in the user's checkout", () => {
    const prompt = facts({ checkout: true })
    assert.isTrue(prompt.startsWith("BODY\n"))
    assert.include(prompt, "You were opened by the user in a terminal; the user reads your replies.")
    assert.include(prompt, "the user's own checkout")
    assert.notInclude(prompt, "To send it your report")
  })

  it("a session another session started sends its report with vibest send using 8-char short ids, and says who inherits it when that one ends", () => {
    const prompt = facts({
      id: "756c38b6-101c-4da9-b8ba-b63399edb05a",
      creator: { id: "c1234567-89ab-4cde-8f01-234567890abc", label: "agent lead" },
      linkedTo: [
        { id: "d1234567-89ab-4cde-8f01-234567890abc", label: "agent reviewer" },
        { id: "f1234567-89ab-4cde-8f01-234567890abc", label: "on cloudide" },
      ],
    })

    assert.include(prompt, "You are session 756c38b6.")
    assert.notInclude(prompt, "756c38b6-101c")
    assert.include(prompt, "You were started by c1234567 (agent lead)")
    assert.include(prompt, "vibest send c1234567 --")
    assert.notInclude(prompt, "c1234567-89ab")
    assert.include(prompt, "d1234567 (agent reviewer), f1234567 (on cloudide).")
    assert.notInclude(prompt, "d1234567-89ab")
    assert.include(prompt, "nearest session above it that is still running")
    assert.include(prompt, "a worktree that only you use")
  })

  it("a worktree shared with an earlier session says so with its 8-char short id", () => {
    const prompt = facts({ sharer: "e1234567-89ab-4cde-8f01-234567890abc" })
    assert.include(prompt, "shared with session e1234567")
    assert.notInclude(prompt, "e1234567-89ab")
  })

  it("every session is told what the two envelopes and the unwrapped text mean", () => {
    const prompt = facts({})
    assert.include(prompt, "You are session a.")
    assert.include(prompt, "`<vibest-agent-message>`")
    assert.include(prompt, "sender's `<session-id>`")
    assert.notInclude(prompt, "<title>")
    assert.include(prompt, "`<vibest-message>`")
    assert.include(prompt, "Text with no wrapper is from the user")
    assert.include(prompt, "MCP servers, the CodeMode JS sandbox, and background automations run through `vibest mcp`")
    assert.include(prompt, "and `vibest automation`")
    assert.include(prompt, "read the `mcp` skill when using them.")
    assert.notInclude(prompt, "Configured MCP servers in this workspace:")
  })

  it("lists configured MCP server names and types in Session facts when present", () => {
    const prompt = facts({
      mcpServers: [
        { name: "context7", type: "remote" },
        { name: "team_kb", type: "local" },
      ],
    })

    assert.include(
      prompt,
      "Configured MCP servers in this workspace: context7 (remote), team_kb (local) (inspect tools with `vibest mcp list <server>` or `vibest mcp search <query>`; batch multi-tool calls with `vibest mcp exec`).",
    )
  })

  it.effect("configuredMcpServers merges global mcp.json with project .mcp.json and skips disabled servers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* tempDirectory("vibest-prompt-mcp-")
      const home = path.join(root, "home")
      const repo = path.join(root, "repo")
      yield* fs.makeDirectory(home, { recursive: true })
      yield* fs.makeDirectory(repo, { recursive: true })

      yield* fs.writeFileString(
        path.join(home, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
            legacy_off: { type: "local", command: ["echo"], disabled: true },
            overridden: { type: "local", command: ["echo"] },
          },
        }),
      )

      yield* fs.writeFileString(
        path.join(repo, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            overridden: { type: "remote", url: "https://override.example.com/mcp" },
            project_db: { type: "local", command: ["npx", "db-mcp"] },
          },
        }),
      )

      const servers = yield* configuredMcpServers(home, repo)
      assert.deepStrictEqual(servers, [
        { name: "context7", type: "remote" },
        { name: "overridden", type: "remote" },
        { name: "project_db", type: "local" },
      ])
    }).pipe(Effect.provide(Platform.services)),
  )
})

describe("projectText: preferences.md and the curated memories/MEMORY.md index injected into every session's system prompt", () => {
  it.effect(
    "loads curated memories/MEMORY.md when present, ignores extra unindexed topic files and instructions.md, and adds the on-demand search header",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-prompt-curated-")

        const write = (rel: string, content: string) =>
          Effect.gen(function* () {
            const file = path.join(dir, rel)
            yield* fs.makeDirectory(path.dirname(file), { recursive: true })
            yield* fs.writeFileString(file, content)
          })

        const curated =
          "- memories/decisions.md — agreed architecture\n- [pitfalls.md](pitfalls.md) — watch out for locks"

        yield* write("preferences.md", "Prefer short diffs.\n")
        yield* write("instructions.md", "SECRET_INSTRUCTIONS_SHOULD_NOT_APPEAR\n")
        yield* write("memories/MEMORY.md", `\n${curated}\n\n`)
        yield* write("memories/decisions.md", "TOPIC_BODY_SHOULD_STAY_ON_DEMAND\n")
        yield* write("memories/unindexed.md", "EXTRA_UNINDEXED_TOPIC_FILE\n")

        const text = yield* projectText(dir)
        assert.strictEqual(text.preferences, "Prefer short diffs.")
        assert.strictEqual(text.memories, curated)
        assert.notInclude(JSON.stringify(text), "SECRET_INSTRUCTIONS_SHOULD_NOT_APPEAR")
        assert.notInclude(text.memories, "TOPIC_BODY_SHOULD_STAY_ON_DEMAND")
        assert.notInclude(text.memories, "unindexed.md")
        assert.notInclude(text.memories, "EXTRA_UNINDEXED_TOPIC_FILE")
        assert.notInclude(text.memories, "WARNING")
        assert.strictEqual(yield* fs.readFileString(path.join(dir, "memories/MEMORY.md")), `\n${curated}\n\n`)

        const prompt = promptOf(dir, text)
        assert.include(prompt, "# User preferences\n\nThis is a snapshot from when your process started;")
        assert.include(prompt, "Prefer short diffs.")
        assert.include(prompt, "# Project memories\n\n")
        assert.include(prompt, "memories/MEMORY.md")
        assert.include(prompt, "vibest project search <query> --kind memories")
        assert.include(prompt, curated)
        assert.notInclude(prompt, "# Project instructions")
        assert.notInclude(prompt, "instructions.md")
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "truncates memories/MEMORY.md past 100 lines on a line boundary and appends a warning naming counts, limits, cut amount, and the 70-line target",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-prompt-lines-cap-")
        const memories = path.join(dir, "memories")
        yield* fs.makeDirectory(memories, { recursive: true })

        const allLines = Array.from(
          { length: 105 },
          (_, i) => `- memories/${String(i + 1).padStart(3, "0")}.md — lesson ${i + 1}`,
        )

        const raw = `${allLines.join("\n")}\n`
        yield* fs.writeFileString(path.join(memories, "MEMORY.md"), raw)

        const text = yield* projectText(dir)
        const [body, warning] = text.memories.split("\n\n> WARNING: ")
        assert.isDefined(body)
        assert.isDefined(warning)
        assert.strictEqual(body.split("\n").length, 100)
        assert.include(body, "- memories/001.md — lesson 1")
        assert.include(body, "- memories/100.md — lesson 100")
        assert.notInclude(body, "memories/101.md")
        assert.notInclude(text.memories, "memories/105.md")
        assert.include(warning, "105 lines")
        assert.include(warning, `${new TextEncoder().encode(allLines.join("\n")).byteLength} bytes`)
        assert.include(warning, "100 lines / 8000 bytes")
        assert.include(warning, "5 lines")
        assert.include(warning, "70 lines")
        assert.include(warning, "topic files")
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "truncates memories/MEMORY.md past 8000 UTF-8 bytes on a clean line boundary even under 100 lines, and appends the compaction warning",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-prompt-bytes-cap-")
        const memories = path.join(dir, "memories")
        yield* fs.makeDirectory(memories, { recursive: true })

        const allLines = Array.from(
          { length: 60 },
          (_, i) => `- memories/entry-${String(i + 1).padStart(2, "0")}.md — ${"测".repeat(40)}`,
        )

        const joined = allLines.join("\n")
        const encoder = new TextEncoder()
        assert.isBelow(joined.length, 8000)
        assert.isAbove(encoder.encode(joined).byteLength, 8000)
        yield* fs.writeFileString(path.join(memories, "MEMORY.md"), `${joined}\n`)

        const text = yield* projectText(dir)
        const [body, warning] = text.memories.split("\n\n> WARNING: ")
        assert.isDefined(body)
        assert.isDefined(warning)
        const keptLines = body.split("\n")
        const keptBytes = encoder.encode(body).byteLength
        const totalBytes = encoder.encode(joined).byteLength
        assert.isAtMost(keptBytes, 8000)
        assert.isAbove(keptBytes + 1 + encoder.encode(allLines[keptLines.length]!).byteLength, 8000)
        assert.strictEqual(keptLines.at(-1), allLines[keptLines.length - 1])
        assert.notInclude(body, allLines[keptLines.length]!)
        assert.include(warning, `60 lines and ${totalBytes} bytes`)
        assert.include(warning, "100 lines / 8000 bytes")
        assert.include(warning, `${60 - keptLines.length} lines (${totalBytes - keptBytes} bytes) cut off`)
        assert.include(warning, "70 lines")
        assert.include(warning, "topic files")
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "bootstraps memories/MEMORY.md once newest-first with deterministic path tie-breaker, 150-char line clip, and 70-line / 5600-byte caps when MEMORY.md is missing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-prompt-bootstrap-")

        const writeDated = (rel: string, content: string, mtimeMs: number) =>
          Effect.gen(function* () {
            const file = path.join(dir, rel)
            yield* fs.makeDirectory(path.dirname(file), { recursive: true })
            yield* fs.writeFileString(file, content)
            yield* fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs))
          })

        const base = Date.UTC(2026, 10, 20, 0, 0, 0)
        yield* writeDated("memories/oldest.md", "#\n", base + 1_000)
        yield* writeDated("memories/named.md", "---\nname: only\n---\n# After the block\n", base + 2_000)
        yield* writeDated("memories/tie-b.md", "second on tie\n", base + 3_000)
        yield* writeDated("memories/nested/tie-a.md", "\n# First on tie\nbody stays in file\n", base + 3_000)
        yield* writeDated("memories/long.md", `${"x".repeat(180)}\n`, base + 4_000)
        yield* writeDated(
          "memories/newest.md",
          '---\nname: newest\ndescription: "from frontmatter"\n---\n# ignored\n',
          base + 5_000,
        )
        yield* writeDated("memories/skip.txt", "not markdown\n", base + 9_000)

        const first = yield* projectText(dir)
        const bootstrappedLines = first.memories.split("\n")
        assert.deepStrictEqual(bootstrappedLines, [
          "- memories/newest.md — from frontmatter",
          `- memories/long.md — ${"x".repeat(150 - "- memories/long.md — ".length)}`,
          "- memories/nested/tie-a.md — First on tie",
          "- memories/tie-b.md — second on tie",
          "- memories/named.md — After the block",
          "- memories/oldest.md",
        ])
        assert.strictEqual(bootstrappedLines[1]!.length, 150)
        assert.notInclude(first.memories, "body stays in file")
        assert.notInclude(first.memories, "skip.txt")
        assert.strictEqual(yield* fs.readFileString(path.join(dir, "memories/MEMORY.md")), `${first.memories}\n`)

        yield* writeDated("memories/later-unindexed.md", "added without updating MEMORY.md\n", base + 20_000)
        const second = yield* projectText(dir)
        assert.strictEqual(second.memories, first.memories)
        assert.notInclude(second.memories, "later-unindexed.md")

        const cappedDir = yield* tempDirectory("vibest-prompt-bootstrap-cap-")
        const cappedMemories = path.join(cappedDir, "memories")
        yield* fs.makeDirectory(cappedMemories, { recursive: true })

        for (let i = 0; i < 75; i++) {
          const file = path.join(cappedMemories, `${String(i).padStart(3, "0")}.md`)
          yield* fs.writeFileString(file, `lesson ${i}\n`)
          const stamp = new Date(base + (100 - i) * 1_000)
          yield* fs.utimes(file, stamp, stamp)
        }

        yield* fs.chmod(path.join(cappedMemories, "074.md"), 0o000)
        const capped = yield* projectText(cappedDir)
        const cappedLines = capped.memories.split("\n")
        assert.strictEqual(cappedLines.length, 70)
        assert.strictEqual(cappedLines[0], "- memories/000.md — lesson 0")
        assert.strictEqual(cappedLines[69], "- memories/069.md — lesson 69")
        assert.notInclude(capped.memories, "070.md")
        assert.notInclude(capped.memories, "WARNING")
        assert.strictEqual(yield* fs.readFileString(path.join(cappedMemories, "MEMORY.md")), `${capped.memories}\n`)

        const byteCapDir = yield* tempDirectory("vibest-prompt-bootstrap-bytes-")
        const byteCapMemories = path.join(byteCapDir, "memories")
        yield* fs.makeDirectory(byteCapMemories, { recursive: true })

        for (let i = 0; i < 50; i++) {
          const file = path.join(byteCapMemories, `${String(i).padStart(2, "0")}.md`)
          yield* fs.writeFileString(file, `${"测".repeat(120)}\n`)
          const stamp = new Date(base + (100 - i) * 1_000)
          yield* fs.utimes(file, stamp, stamp)
        }

        const byteCapped = yield* projectText(byteCapDir)
        assert.isBelow(byteCapped.memories.split("\n").length, 50)
        assert.isAtMost(new TextEncoder().encode(byteCapped.memories).byteLength, 5600)
        assert.notInclude(byteCapped.memories, "WARNING")
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "omits # Project memories when memories/ has no .md files and no MEMORY.md, or when MEMORY.md is blank",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-prompt-empty-")
        yield* fs.makeDirectory(path.join(dir, "memories"), { recursive: true })
        yield* fs.writeFileString(path.join(dir, "memories/skip.txt"), "not markdown\n")
        yield* fs.writeFileString(path.join(dir, "instructions.md"), "still not read\n")
        const text = yield* projectText(dir)
        assert.strictEqual(text.preferences, "")
        assert.strictEqual(text.memories, "")
        assert.isFalse(yield* fs.exists(path.join(dir, "memories/MEMORY.md")))
        assert.notInclude(promptOf(dir, text), "# User preferences")
        assert.notInclude(promptOf(dir, text), "# Project memories")

        yield* fs.writeFileString(path.join(dir, "memories/MEMORY.md"), "   \n")
        yield* fs.writeFileString(path.join(dir, "memories/topic.md"), "unindexed\n")
        const blank = yield* projectText(dir)
        assert.strictEqual(blank.memories, "")
        assert.notInclude(promptOf(dir, blank), "# Project memories")

        const missing = yield* projectText(path.join(dir, "no-such-project"))
        assert.deepStrictEqual(missing, { preferences: "", memories: "" })
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("cuts cleanly before line 1 with 0 lines loaded when a single line exceeds 8000 bytes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* tempDirectory("vibest-prompt-single-huge-")
      const memories = path.join(dir, "memories")
      yield* fs.makeDirectory(memories, { recursive: true })
      yield* fs.writeFileString(path.join(memories, "MEMORY.md"), `${"x".repeat(8500)}\n`)

      const text = yield* projectText(dir)
      assert.isTrue(
        text.memories.startsWith(
          "> WARNING: memories/MEMORY.md is 1 line and 8500 bytes (limit: 100 lines / 8000 bytes). Loaded 0 of 1 line (0 bytes); 1 line (8500 bytes) cut off.",
        ),
      )
      assert.notInclude(text.memories, "xxxx")
      assert.include(text.memories, "70 lines")
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "concurrent bootstrap does not clobber a curated MEMORY.md written mid-scan, and returns the curated index",
    () =>
      Effect.gen(function* () {
        const realFs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-prompt-race-")
        const memoriesDir = path.join(dir, "memories")
        yield* realFs.makeDirectory(memoriesDir, { recursive: true })
        yield* realFs.writeFileString(path.join(memoriesDir, "old-topic.md"), "legacy lesson from topic file\n")

        const scanStarted = yield* Deferred.make<void>()
        const curatedWritten = yield* Deferred.make<void>()

        const hookedFs: FileSystem.FileSystem = {
          ...realFs,
          readDirectory: (target, options) =>
            options?.recursive === true
              ? realFs.readDirectory(target, options).pipe(
                  Effect.tap(() => Deferred.succeed(scanStarted, undefined)),
                  Effect.tap(() => Deferred.await(curatedWritten)),
                )
              : realFs.readDirectory(target, options),
        }

        const fiber = yield* Effect.forkChild(
          projectText(dir).pipe(Effect.provideService(FileSystem.FileSystem, hookedFs)),
        )

        yield* Deferred.await(scanStarted)
        const curatedLine = "- memories/curated.md — carefully curated index entry"
        yield* realFs.writeFileString(path.join(memoriesDir, "MEMORY.md"), `${curatedLine}\n`)
        yield* Deferred.succeed(curatedWritten, undefined)

        const result = yield* Fiber.join(fiber)
        const diskAfter = yield* realFs.readFileString(path.join(memoriesDir, "MEMORY.md"))
        const remaining = yield* realFs.readDirectory(memoriesDir)

        assert.strictEqual(diskAfter, `${curatedLine}\n`)
        assert.strictEqual(result.memories, curatedLine)
        assert.deepStrictEqual(
          remaining.filter((name) => name.endsWith(".tmp")),
          [],
        )
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("interrupted bootstrap cleans up temporary files and leaves zero .tmp files in memories/", () =>
    Effect.gen(function* () {
      const realFs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* tempDirectory("vibest-prompt-interrupt-")
      const memoriesDir = path.join(dir, "memories")
      yield* realFs.makeDirectory(memoriesDir, { recursive: true })
      yield* realFs.writeFileString(path.join(memoriesDir, "topic.md"), "lesson body\n")

      const tmpReady = yield* Deferred.make<void>()
      const neverFinish = yield* Deferred.make<void>()

      const pausePublish = <A, E>(op: Effect.Effect<A, E>) =>
        Deferred.succeed(tmpReady, undefined).pipe(Effect.andThen(Deferred.await(neverFinish)), Effect.andThen(op))

      const interruptFs: FileSystem.FileSystem = {
        ...realFs,
        rename: (from, to) => pausePublish(realFs.rename(from, to)),
        link: (from, to) => pausePublish(realFs.link(from, to)),
      }

      const fiber = yield* Effect.forkChild(
        projectText(dir).pipe(Effect.provideService(FileSystem.FileSystem, interruptFs)),
      )

      yield* Deferred.await(tmpReady)
      yield* Fiber.interrupt(fiber)

      const remaining = yield* realFs.readDirectory(memoriesDir)
      assert.deepStrictEqual(
        remaining.filter((name) => name.endsWith(".tmp")),
        [],
      )
    }).pipe(Effect.provide(Platform.services)),
  )
})
