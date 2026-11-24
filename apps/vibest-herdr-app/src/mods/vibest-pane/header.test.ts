import { describe, expect, it } from "vitest"

import { shortFolder } from "./header.ts"

describe("shortFolder", () => {
  it("writes the home folder as ~", () => {
    expect(shortFolder("/home/a", "/home/a")).toBe("~")
    expect(shortFolder("/home/a/src/x", "/home/a")).toBe("~/src/x")
    expect(shortFolder("/home/ab", "/home/a")).toBe("/home/ab")
    expect(shortFolder(null, "/home/a")).toBe("")
  })
})
