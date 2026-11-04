// preferences.md and the memory index injected into every agent's system prompt.
import { assert, describe, it } from "@effect/vitest"
import { coordinatorSystemPrompt, projectText, sessionSystemPrompt } from "@vibest/core/system-prompt"
import { Effect, FileSystem, Path } from "effect"

import * as Platform from "#platform"

import { tempDirectory } from "./fakes.ts"

const promptOf = (dir: string, text: { preferences: string; memories: string }) =>
  sessionSystemPrompt({ id: "a", projectDir: dir, vibest: ["vibest"], ...text })

describe("projectText", () => {
  it.effect("indexes memories, injects preferences.md, and does not read instructions.md", () =>
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
      // Frontmatter with no description falls back to the first line after it.
      yield* write("memories/named.md", "---\nname: only\n---\n# After the block\n")

      const text = yield* projectText(dir)
      assert.strictEqual(text.preferences, "Prefer short diffs.")
      assert.notInclude(JSON.stringify(text), "SECRET_INSTRUCTIONS_SHOULD_NOT_APPEAR")
      assert.include(text.memories, "- memories/front.md — from frontmatter")
      assert.include(text.memories, "- memories/nested/plain.md — Plain title")
      assert.notInclude(text.memories, "body that stays in the file")
      assert.include(text.memories, "- memories/named.md — After the block")
      assert.include(text.memories, `- memories/long.md — ${"x".repeat(150)}`)
      assert.notInclude(text.memories, "x".repeat(151))
      assert.notInclude(text.memories, "skip.txt")
      assert.include(
        text.memories,
        "Each line is a file in the project folder; read it with your file tools when its line is relevant to the work.",
      )
      const prompt = promptOf(dir, text)
      assert.include(prompt, "# User preferences\n\nPrefer short diffs.")
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

  it.effect("caps the memory index at 200 lines and says how many were left out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* tempDirectory("vibest-prompt-cap-")
      const memories = path.join(dir, "memories")
      yield* fs.makeDirectory(memories)
      for (let i = 0; i < 201; i++)
        yield* fs.writeFileString(path.join(memories, `${String(i).padStart(3, "0")}.md`), `lesson ${i}\n`)
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

describe("system prompt rules", () => {
  it("tells the coordinator how to record a preference and a memory, and keeps preferences.md read-only for a subagent", () => {
    const coordinator = coordinatorSystemPrompt({ projectDir: "/p", preferences: "Be brief.", memories: "" })
    assert.include(
      coordinator,
      "when the user states a lasting preference about how work should be done, add or update one short line in it with your file tools; do not record one-off requests.",
    )
    assert.include(
      coordinator,
      "Each memory file holds one lesson and starts with a one-line summary (or frontmatter with `name` and `description`), because that line is what the index shows",
    )
    assert.include(coordinator, "# User preferences\n\nBe brief.")
    assert.notInclude(coordinator, "instructions.md")
    const session = sessionSystemPrompt({
      id: "a",
      projectDir: "/p",
      vibest: ["vibest"],
      preferences: "",
      memories: "",
    })
    assert.include(
      session,
      "preferences.md are the user's and the coordinator's: read them, and change them only when your task says so.",
    )
    assert.notInclude(session, "instructions.md")
  })
})
