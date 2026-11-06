import { describe, expect, it } from "vitest"

import { parseDisableDirective } from "./no-restricted-disable.mjs"

describe("parseDisableDirective", () => {
  it("ignores ordinary comments", () => {
    expect(parseDisableDirective("not a disable directive")).toBeNull()
  })

  it("treats a missing rule list as a blanket disable", () => {
    expect(parseDisableDirective("eslint-disable")).toEqual({ rules: null })
    expect(parseDisableDirective("oxlint-disable")).toEqual({ rules: null })
  })

  it("keeps only the rule name when a disable lists several", () => {
    expect(parseDisableDirective("eslint-disable-next-line unicorn/prefer-node-protocol, no-console")).toEqual({
      rules: ["unicorn/prefer-node-protocol", "no-console"],
    })
  })
})
