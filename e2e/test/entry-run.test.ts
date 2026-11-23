import { expect, test } from "bun:test"

import { exitStatusOf } from "../src/world.ts"

test("an exit status file counts as published only once it holds an integer", () => {
  expect(exitStatusOf("")).toBeUndefined()
  expect(exitStatusOf("\n")).toBeUndefined()
  expect(exitStatusOf("2\n")).toBe(2)
  expect(exitStatusOf("0\n")).toBe(0)
})
