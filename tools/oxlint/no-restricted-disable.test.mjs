import { describe, expect, it } from "vitest"

import { parseDisableDirective } from "./no-restricted-disable.mjs"

describe("parseDisableDirective", () => {
  it("ignores ordinary comments", () => {
    expect(parseDisableDirective("not a disable directive")).toBeNull()
  })

  it("drops the reason after --", () => {
    expect(parseDisableDirective("oxlint-disable-next-line eslint/no-unused-vars -- fresh")).toEqual({
      rules: ["eslint/no-unused-vars"],
    })
  })

  it("treats a missing rule list as a blanket disable", () => {
    expect(parseDisableDirective("eslint-disable")).toEqual({ rules: null })
    expect(parseDisableDirective("oxlint-disable")).toEqual({ rules: null })
  })

  it("reads a single rule name", () => {
    expect(parseDisableDirective("eslint-disable-next-line vibest/node-import-style").rules).toEqual([
      "vibest/node-import-style",
    ])
  })

  it("keeps only the rule name when a disable lists several", () => {
    expect(parseDisableDirective("eslint-disable-next-line unicorn/prefer-node-protocol, no-console")).toEqual({
      rules: ["unicorn/prefer-node-protocol", "no-console"],
    })
  })
})
