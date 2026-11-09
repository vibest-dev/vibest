import { describe, expect, it } from "vitest"

import { closeFile, EMPTY_TABS, fileName, openFile, selectFile } from "./viewer-tabs.ts"

const a = { path: "/r/a.ts", on: null as string | null }
const b = { path: "/r/b.ts", on: null as string | null }
const c = { path: "/r/c.ts", on: null as string | null }

describe("viewer tabs", () => {
  it("opens a file once and makes it active", () => {
    const tabs = openFile(openFile(openFile(EMPTY_TABS, a), b), a)
    expect(tabs).toEqual({ files: [a, b], active: a.path })
  })

  it("selects an open tab and ignores a closed one", () => {
    const two = openFile(openFile(EMPTY_TABS, a), b)
    expect(selectFile(two, a.path).active).toBe(a.path)
    expect(selectFile(two, c.path)).toBe(two)
  })

  it("closing the active tab activates its neighbor, or nothing when it was the last", () => {
    const three = openFile(openFile(openFile(EMPTY_TABS, a), b), c)
    expect(closeFile(selectFile(three, b.path), b.path)).toEqual({ files: [a, c], active: c.path })
    expect(closeFile(three, c.path)).toEqual({ files: [a, b], active: b.path })
    expect(closeFile(three, a.path).active).toBe(c.path)
    expect(closeFile(openFile(EMPTY_TABS, a), a.path)).toEqual(EMPTY_TABS)
  })

  it("names a file by its last path part", () => {
    expect(fileName("/r/src/a.ts")).toBe("a.ts")
    expect(fileName("C:\\r\\b.ts")).toBe("b.ts")
  })
})
