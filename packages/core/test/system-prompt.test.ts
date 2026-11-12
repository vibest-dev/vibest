import { assert, describe, it } from "@effect/vitest"
import { projectText, systemPrompt } from "@vibest/core/system-prompt"
import { Effect, FileSystem, Path } from "effect"

import { tempDirectory } from "./lib/directory.ts"
import * as Platform from "./platform/bun.ts"

const promptOf = (dir: string, text: { preferences: string; memories: string }) =>
  systemPrompt({ system: "You are an agent.\n", id: "a", projectDir: dir, vibest: ["vibest"], ...text })

const facts = (extra: Partial<Parameters<typeof systemPrompt>[0]>) =>
  systemPrompt({
    system: "BODY\n",
    id: "a",
    projectDir: "/p",
    vibest: ["vibest"],
    preferences: "",
    memories: "",
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

  it("a session another session started sends its report with vibest send, and says who inherits it when that one ends", () => {
    const prompt = facts({ creator: { id: "c1", label: "agent lead" } })
    assert.include(prompt, "You were started by c1 (agent lead)")
    assert.include(prompt, "vibest send c1 --")
    assert.include(prompt, "nearest session above it that is still running")
    assert.include(prompt, "a worktree that only you use")
  })

  it("a worktree shared with an earlier session says so", () => {
    assert.include(facts({ peer: "e1" }), "shared with session e1")
  })

  it("every session is told what the two envelopes and the unwrapped text mean", () => {
    const prompt = facts({})
    assert.include(prompt, "`<agent-message>`")
    assert.include(prompt, "`<vibest-notice>`")
    assert.include(prompt, "Text with no wrapper is from the user")
  })
})

describe("projectText: preferences.md and the memory index injected into every agent's system prompt", () => {
  it.effect(
    "indexes memories (frontmatter with no description falls back to the first line after it), injects preferences.md, and does not read instructions.md",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-prompt-")
        const write = (rel: string, content: string) =>
          Effect.gen(function* () {
            const file = path.join(dir, rel)
            yield* fs.makeDirectory(path.dirname(file), { recursive: true })
            yield* fs.writeFileString(file, content)
          })
        yield* write("preferences.md", "Prefer short diffs.\n")
        yield* write("instructions.md", "SECRET_INSTRUCTIONS_SHOULD_NOT_APPEAR\n")
        yield* write("memories/front.md", '---\nname: front\ndescription: "from frontmatter"\n---\n# ignored title\n')
        yield* write("memories/nested/plain.md", "\n# Plain title\nbody that stays in the file\n")
        yield* write("memories/long.md", `${"x".repeat(180)}\n`)
        yield* write("memories/skip.txt", "not markdown\n")
        yield* write("memories/named.md", "---\nname: only\n---\n# After the block\n")
        yield* write("memories/blank.md", "#\n")

        const text = yield* projectText(dir)
        assert.strictEqual(text.preferences, "Prefer short diffs.")
        assert.notInclude(JSON.stringify(text), "SECRET_INSTRUCTIONS_SHOULD_NOT_APPEAR")
        assert.include(text.memories, "- memories/front.md — from frontmatter")
        assert.include(text.memories, "- memories/nested/plain.md — Plain title")
        assert.notInclude(text.memories, "body that stays in the file")
        assert.include(text.memories, "- memories/named.md — After the block")
        assert.strictEqual(
          text.memories.split("\n").find((line) => line.includes("blank.md")),
          "- memories/blank.md",
        )
        assert.include(text.memories, `- memories/long.md — ${"x".repeat(150)}`)
        assert.notInclude(text.memories, "x".repeat(151))
        assert.notInclude(text.memories, "skip.txt")
        assert.include(
          text.memories,
          "Each line is a file in the project folder; read it with your file tools when its line is relevant to the work.",
        )
        const prompt = promptOf(dir, text)
        assert.include(prompt, "# User preferences\n\nThis is a snapshot from when your process started;")
        assert.include(prompt, "Prefer short diffs.")
        assert.include(prompt, "# Project memories\n\n")
        assert.notInclude(prompt, "# Project instructions")
        assert.notInclude(prompt, "instructions.md")
      }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("a missing preferences.md and an empty memories folder inject nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* tempDirectory("vibest-prompt-empty-")
      yield* fs.makeDirectory(path.join(dir, "memories"), { recursive: true })
      yield* fs.writeFileString(path.join(dir, "instructions.md"), "still not read\n")
      const text = yield* projectText(dir)
      assert.strictEqual(text.preferences, "")
      assert.strictEqual(text.memories, "")
      assert.notInclude(promptOf(dir, text), "# User preferences")
      assert.notInclude(promptOf(dir, text), "# Project memories")
      const missing = yield* projectText(path.join(dir, "no-such-project"))
      assert.deepStrictEqual(missing, { preferences: "", memories: "" })
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect(
    "caps the memory index at 200 lines and says how many were left out, counted from the listing without reading them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* tempDirectory("vibest-prompt-cap-")
        const memories = path.join(dir, "memories")
        yield* fs.makeDirectory(memories)
        for (let i = 0; i < 201; i++)
          yield* fs.writeFileString(path.join(memories, `${String(i).padStart(3, "0")}.md`), `lesson ${i}\n`)
        const unreadablePastTheCap = path.join(memories, "200.md")
        yield* fs.chmod(unreadablePastTheCap, 0o000)
        const text = yield* projectText(dir)
        assert.strictEqual(text.preferences, "")
        const lines = text.memories.split("\n").filter((line) => line.startsWith("- memories/"))
        assert.strictEqual(lines.length, 200)
        assert.include(text.memories, "- memories/000.md — lesson 0")
        assert.include(text.memories, "- memories/199.md — lesson 199")
        assert.notInclude(text.memories, "memories/200.md")
        assert.include(text.memories, "1 entry left out; the folder holds them all.")
      }).pipe(Effect.provide(Platform.services)),
  )
})
