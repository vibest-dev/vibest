import { describe, expect, it } from "vitest"

import { mergeKeys } from "./merge-keys.ts"

describe("mergeKeys", () => {
  it("adds vibest's sections and keys without replacing the person's own", () => {
    const mine = { global: { "ctrl-tab": "tab.next" }, "layout:vibest": { "ctrl-tab": "tab.next" } }
    const shipped = { "layout:vibest": { "ctrl-tab": "vibest-projects.recent", "ctrl-1": "x" } }

    expect(mergeKeys(mine, shipped)).toEqual({
      keys: { global: { "ctrl-tab": "tab.next" }, "layout:vibest": { "ctrl-tab": "tab.next", "ctrl-1": "x" } },
      kept: ["layout:vibest ctrl-tab"],
    })
    expect(mergeKeys({ global: {} }, shipped).keys["layout:vibest"]).toEqual(shipped["layout:vibest"])
  })
})
