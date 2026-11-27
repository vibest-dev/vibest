import { assert, describe, it } from "@effect/vitest"
import { renderDeclarations } from "@vibest/codemode/declarations"

describe("@vibest/codemode renderDeclarations", () => {
  it("renders TypeScript declarations grouped by server namespace", () => {
    const dts = renderDeclarations([
      {
        server: "github",
        name: "list_issues",
        description: "List repository issues",
        inputSchema: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["open", "closed"] },
            limit: { type: "integer" },
          },
          required: ["state"],
        },
      },
      {
        server: "my-crm",
        name: "get-user",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ])

    assert.include(dts, "declare const tools:")
    assert.include(dts, "github: {")
    assert.include(dts, "/** List repository issues */")
    assert.include(dts, 'list_issues(args?: { state: "open" | "closed"; limit?: number; }): Promise<unknown>;')
    assert.include(dts, "my_crm: {")
    assert.include(dts, "get_user(args?: { id: string; }): Promise<unknown>;")
    assert.include(dts, "declare function store(key: string, value: unknown): void;")
  })
})
