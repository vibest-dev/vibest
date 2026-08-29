import { describe, expect, it } from "vitest";

import { isProtectedRule, parseDisableDirective } from "./no-restricted-disable.mjs";

describe("parseDisableDirective", () => {
  it("ignores ordinary comments", () => {
    expect(parseDisableDirective("not a disable directive")).toBeNull();
  });

  it("allows named disables that are not protected", () => {
    const parsed = parseDisableDirective("oxlint-disable-next-line unicorn/no-array-sort -- fresh");
    expect(parsed).toEqual({ rules: ["unicorn/no-array-sort"] });
    expect(parsed.rules.every((rule) => !isProtectedRule(rule))).toBe(true);
  });

  it("treats a missing rule list as a blanket disable", () => {
    expect(parseDisableDirective("eslint-disable")).toEqual({ rules: null });
    expect(parseDisableDirective("oxlint-disable")).toEqual({ rules: null });
  });

  it("flags the React effect rules and exhaustive-deps aliases", () => {
    expect(
      parseDisableDirective(
        "eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler",
      ).rules,
    ).toEqual(["react-you-might-not-need-an-effect/no-event-handler"]);
    expect(isProtectedRule("react-you-might-not-need-an-effect/no-event-handler")).toBe(true);
    expect(
      isProtectedRule("react-you-might-not-need-an-effect/no-external-store-subscription"),
    ).toBe(true);
    expect(isProtectedRule("react-hooks/exhaustive-deps")).toBe(true);
    expect(isProtectedRule("react/exhaustive-deps")).toBe(true);
    expect(isProtectedRule("vibest/no-restricted-disable")).toBe(true);
  });

  it("keeps only the rule name when a disable lists several", () => {
    expect(
      parseDisableDirective("eslint-disable-next-line react/exhaustive-deps, no-console"),
    ).toEqual({
      rules: ["react/exhaustive-deps", "no-console"],
    });
  });
});
