import { assert, describe, it } from "vitest"

import { agentsFrom } from "../src/agent-file.ts"
import { coordinator, general } from "../src/agent.ts"

const file = (name: string, text: string | undefined) => ({ name, path: `/home/agents/${name}`, text })

const read = (...files: ReadonlyArray<ReturnType<typeof file>>) => agentsFrom(files, [coordinator, general])

const errorOf = (result: ReturnType<typeof read>, id: string) => result.invalid.find((agent) => agent.id === id)?.error

describe("agent files", () => {
  it("a file defines an agent with its launch fields", () => {
    const result = read(
      file("reviewer.md", "---\ndescription: reviews\nharness: pi\nprovider: 'cpamp'\nmodel: gpt\n---\n\nReview it.\n"),
    )

    assert.deepStrictEqual(result.invalid, [])
    assert.deepStrictEqual(result.definitions, [
      { id: "reviewer", description: "reviews", system: "Review it.", harness: "pi", provider: "cpamp", model: "gpt" },
    ])
  })

  it("every rule a file can break makes it invalid without affecting the others", () => {
    const result = read(
      file("Planner.md", "---\ndescription: x\n---\nbody"),
      file("color.md", "---\ndescription: x\ncolor: red\n---\nbody"),
      file("named.md", "---\nname: other\ndescription: x\n---\nbody"),
      file("nodesc.md", "---\nharness: pi\n---\nbody"),
      file("empty.md", "---\ndescription: x\n---\n\n"),
      file("model.md", "---\ndescription: x\nmodel: m\n---\nbody"),
      file("plain.md", "no frontmatter"),
      file("open.md", "---\ndescription: x\nbody"),
      file("twice.md", "---\ndescription: x\ndescription: y\n---\nbody"),
      file("gone.md", undefined),
      file("fine.md", "---\nname: fine\ndescription: x\n---\nbody"),
    )

    assert.deepStrictEqual(
      result.definitions.map((definition) => definition.id),
      ["fine"],
    )
    assert.include(errorOf(result, "Planner"), "lowercase")
    assert.include(errorOf(result, "color"), "unknown key color")
    assert.include(errorOf(result, "named"), "differs from the file name")
    assert.include(errorOf(result, "nodesc"), "description is missing")
    assert.include(errorOf(result, "empty"), "prompt")
    assert.include(errorOf(result, "model"), "need harness")
    assert.include(errorOf(result, "plain"), "must start with a --- line")
    assert.include(errorOf(result, "open"), "no closing")
    assert.include(errorOf(result, "twice"), "twice")
    assert.include(errorOf(result, "gone"), "cannot be read")
    assert.strictEqual(result.invalid.find((agent) => agent.id === "color")?.source, "/home/agents/color.md")
  })

  it("extends puts the extended prompt first and keeps its guard, one level only", () => {
    const result = read(
      file("general.md", "---\ndescription: mine\nextends: general\n---\nAlso this."),
      file("reviewer.md", "---\ndescription: r\nextends: general\n---\nReview."),
      file("base.md", "---\ndescription: b\n---\nBase."),
      file("child.md", "---\ndescription: c\nextends: base\n---\nChild."),
      file("grandchild.md", "---\ndescription: g\nextends: child\n---\nNo."),
      file("nothing.md", "---\ndescription: n\nextends: nosuch\n---\nNo."),
      file("self.md", "---\ndescription: s\nextends: self\n---\nNo."),
    )

    const find = (id: string) => result.definitions.find((definition) => definition.id === id)
    assert.strictEqual(find("general")?.system, `${general.system}\n\nAlso this.`)
    assert.strictEqual(find("general")?.guard, general.guard)
    assert.strictEqual(find("reviewer")?.system, `${general.system}\n\nAlso this.\n\nReview.`)
    assert.strictEqual(find("child")?.system, "Base.\n\nChild.")
    assert.isUndefined(find("child")?.guard)
    assert.include(errorOf(result, "grandchild"), "only one level")
    assert.include(errorOf(result, "nothing"), "no agent has that id")
    assert.include(errorOf(result, "self"), "no built-in agent")
  })
})
