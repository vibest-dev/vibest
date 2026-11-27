import { assert, describe, it } from "vitest"

import { agentsFrom } from "../src/agent-file.ts"

const file = (name: string, text: string | undefined) => ({ name, path: `/home/agents/${name}`, text })

const read = (...files: ReadonlyArray<ReturnType<typeof file>>) => agentsFrom(files)

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

  it("a file named general is only its own prompt, and extends is an unknown key", () => {
    const result = read(
      file("general.md", "---\ndescription: mine\n---\nOnly this."),
      file("old.md", "---\ndescription: mine\nextends: general\n---\nAlso this."),
      file("blank.md", '---\ndescription: " "\n---\nBase.'),
    )

    assert.deepStrictEqual(result.definitions, [{ id: "general", description: "mine", system: "Only this." }])
    assert.include(errorOf(result, "old"), "unknown key extends")
    assert.include(errorOf(result, "blank"), "description is empty")
  })

  it("parses mcpServers in inline, empty, and block list forms without warnings", () => {
    const result = read(
      file("empty-inline.md", "---\ndescription: none\nmcpServers: []\n---\nBody."),
      file("empty-block.md", "---\ndescription: none\nmcpServers:\nharness: pi\n---\nBody."),
      file("inline.md", "---\ndescription: inline\nmcpServers: [context7, \"github\", 'linear', context7]\n---\nBody."),
      file(
        "block.md",
        "---\ndescription: block\nmcpServers:\n  - context7\n  - \"github\"\n  - 'context7'\n---\nBody.",
      ),
    )

    assert.deepStrictEqual(result.invalid, [])
    assert.deepStrictEqual(result.definitions, [
      { id: "empty-inline", description: "none", system: "Body.", mcpServers: [] },
      { id: "empty-block", description: "none", system: "Body.", harness: "pi", mcpServers: [] },
      { id: "inline", description: "inline", system: "Body.", mcpServers: ["context7", "github", "linear"] },
      { id: "block", description: "block", system: "Body.", mcpServers: ["context7", "github"] },
    ])
  })

  it("keeps agents valid with non-blocking warnings for Claude Code inline mcpServers objects and malformed scalars", () => {
    const result = read(
      file(
        "claude-block.md",
        [
          "---",
          "description: claude style",
          "mcpServers:",
          "  - context7",
          "  - playwright:",
          "      type: stdio",
          "      command: npx",
          '      args: ["@playwright/mcp"]',
          "  - sentry: { type: remote, url: https://sentry.example/mcp }",
          "  - { type: stdio, command: npx }",
          "---",
          "Body.",
        ].join("\n"),
      ),
      file("scalar.md", "---\ndescription: scalar\nmcpServers: 123\n---\nBody."),
      file("dup.md", "---\ndescription: dup\nmcpServers: []\nmcpServers: []\n---\nBody."),
    )

    assert.deepStrictEqual(
      result.definitions.map((d) => d.id),
      ["claude-block", "scalar"],
    )

    const claude = result.definitions.find((d) => d.id === "claude-block")!
    assert.deepStrictEqual(claude.mcpServers, ["context7", "playwright", "sentry"])
    assert.strictEqual(claude.warnings?.length, 3)
    assert.include(claude.warnings![0], 'inline mcpServers config for "playwright" is ignored')
    assert.include(claude.warnings![1], 'inline mcpServers config for "sentry" is ignored')
    assert.include(claude.warnings![2], "inline mcpServers object entry is ignored")

    const scalar = result.definitions.find((d) => d.id === "scalar")!
    assert.deepStrictEqual(scalar.mcpServers, [])
    assert.strictEqual(scalar.warnings?.length, 1)
    assert.include(scalar.warnings![0], "must be a list")

    assert.include(errorOf(result, "dup"), "mcpServers is given twice")
  })

  it("handles YAML block anonymous objects, inline comments, multi-key inline maps, and multi-line flow lists without failing open", () => {
    const result = read(
      file(
        "anon-block.md",
        [
          "---",
          "description: block anonymous",
          "mcpServers:",
          "  - type: stdio",
          "    command: npx",
          "---",
          "Body.",
        ].join("\n"),
      ),
      file("inline-comment.md", "---\ndescription: comment\nmcpServers: [alpha, beta] # comment\n---\nBody."),
      file("anon-inline.md", "---\ndescription: anon inline\nmcpServers: { type: stdio, command: npx }\n---\nBody."),
      file(
        "multi-inline-map.md",
        "---\ndescription: multi map\nmcpServers: { alpha: { command: npx }, beta: { command: uvx } }\n---\nBody.",
      ),
      file(
        "block-comment.md",
        ["---", "description: block comment", "mcpServers:", "  - alpha # comment", "---", "Body."].join("\n"),
      ),
      file(
        "multiline-flow.md",
        ["---", "description: flow", "mcpServers: [", "  alpha,", "  beta", "]", "---", "Body."].join("\n"),
      ),
    )

    assert.deepStrictEqual(result.invalid, [])

    const byId = (id: string) => result.definitions.find((d) => d.id === id)!

    assert.deepStrictEqual(byId("anon-block").mcpServers, [])
    assert.strictEqual(byId("anon-block").warnings?.length, 1)
    assert.include(byId("anon-block").warnings![0], "inline mcpServers object entry is ignored")

    assert.deepStrictEqual(byId("inline-comment").mcpServers, ["alpha", "beta"])
    assert.isUndefined(byId("inline-comment").warnings)

    assert.deepStrictEqual(byId("anon-inline").mcpServers, [])
    assert.strictEqual(byId("anon-inline").warnings?.length, 1)
    assert.include(byId("anon-inline").warnings![0], "inline mcpServers object entry is ignored")

    assert.deepStrictEqual(byId("multi-inline-map").mcpServers, ["alpha", "beta"])
    assert.strictEqual(byId("multi-inline-map").warnings?.length, 2)
    assert.include(byId("multi-inline-map").warnings![0], 'inline mcpServers config for "alpha" is ignored')
    assert.include(byId("multi-inline-map").warnings![1], 'inline mcpServers config for "beta" is ignored')

    assert.deepStrictEqual(byId("block-comment").mcpServers, ["alpha"])
    assert.isUndefined(byId("block-comment").warnings)

    assert.deepStrictEqual(byId("multiline-flow").mcpServers, ["alpha", "beta"])
    assert.isUndefined(byId("multiline-flow").warnings)
  })
})
