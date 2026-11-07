import { assert, describe, it } from "@effect/vitest"

import { goComments } from "./go-comments.ts"

describe("goComments", () => {
  it("finds line and block comments with their line numbers", () => {
    const source = "package a\n\n// doc\nfunc f() {\n\tx := 1 /* why\n\tmore */\n\ty := 2 // trailing\n}\n"
    assert.deepStrictEqual(
      goComments(source).map((comment) => comment.line),
      [3, 5, 7],
    )
  })

  it("ignores comment markers inside strings, runes and raw strings", () => {
    const source =
      'package a\n\nvar s = "// no \\" /* no"\nvar r = \'/\'\nvar raw = `\n// no\n/* no */`\nvar after = 1 // yes\n'
    assert.deepStrictEqual(goComments(source), [{ line: 8, text: "// yes" }])
  })

  it("allows go directives, nolint and the cgo preamble", () => {
    const source =
      '//go:build darwin\n\npackage a\n\n// #include <stdio.h>\nimport "C"\n\n//go:embed x\nvar x string\n\nvar y = 1 //nolint:unused\n'
    assert.deepStrictEqual(goComments(source), [])
  })
})
