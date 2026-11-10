import { assert, describe, it } from "@effect/vitest"
import { coordinatorSystemPrompt, projectText, sessionSystemPrompt } from "@vibest/core/system-prompt"
import { Effect, FileSystem, Path } from "effect"

import { tempDirectory } from "./lib/directory.ts"
import * as Platform from "./platform/bun.ts"

const promptOf = (dir: string, text: { preferences: string; memories: string }) =>
  sessionSystemPrompt({ id: "a", projectDir: dir, vibest: ["vibest"], ...text })

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
        assert.include(prompt, "# User preferences\n\nPrefer short diffs.")
        assert.include(
          coordinatorSystemPrompt({ projectDir: dir, ...text }),
          "# User preferences\n\nPrefer short diffs.",
        )
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
