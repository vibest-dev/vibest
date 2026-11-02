import { describe, expect, it } from "vitest"

import { isProtectedRule, parseDisableDirective } from "./no-restricted-disable.mjs"

describe("parseDisableDirective", () => {
  it("ignores ordinary comments", () => {
    expect(parseDisableDirective("not a disable directive")).toBeNull()
  })

  it("allows named disables that are not protected", () => {
    const parsed = parseDisableDirective("oxlint-disable-next-line eslint/no-unused-vars -- fresh")
    expect(parsed).toEqual({ rules: ["eslint/no-unused-vars"] })
    expect(parsed.rules.every((rule) => !isProtectedRule(rule))).toBe(true)
  })

  it("treats a missing rule list as a blanket disable", () => {
    expect(parseDisableDirective("eslint-disable")).toEqual({ rules: null })
    expect(parseDisableDirective("oxlint-disable")).toEqual({ rules: null })
  })

  it("flags the Node builtin import rules", () => {
    expect(parseDisableDirective("eslint-disable-next-line vibest/node-import-style").rules).toEqual([
      "vibest/node-import-style",
    ])
    expect(isProtectedRule("vibest/node-import-style")).toBe(true)
    expect(isProtectedRule("unicorn/prefer-node-protocol")).toBe(true)
    expect(isProtectedRule("vibest/no-restricted-disable")).toBe(true)
  })

  it("keeps only the rule name when a disable lists several", () => {
    expect(parseDisableDirective("eslint-disable-next-line unicorn/prefer-node-protocol, no-console")).toEqual({
      rules: ["unicorn/prefer-node-protocol", "no-console"],
    })
  })
})
