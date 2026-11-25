import { describe, expect, it } from "vitest"

import { isProjectSpace, isProjectTab } from "./project-space.ts"

describe("project space", () => {
  it("knows the project space and tabs on any machine", () => {
    expect(isProjectSpace("vibest-projects")).toBe(true)
    expect(isProjectSpace("mac-mini/vibest-projects")).toBe(true)
    expect(isProjectSpace("sp123")).toBe(false)
    expect(isProjectTab("mac-mini/vibest-01af")).toBe(true)
    expect(isProjectTab("tb123")).toBe(false)
    expect(isProjectTab(null)).toBe(false)
  })
})
