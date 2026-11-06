import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, assert, describe, it } from "@effect/vitest"

import { prepareClaudeTypes, sha256 } from "../scripts/prepare-claude-types.ts"

const dirs: string[] = []
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-types-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const bytes = (text: string) => new TextEncoder().encode(text)
const refused = async () => {
  throw new Error("fetch should not run")
}
const rejects = async (run: () => Promise<unknown>, pattern: RegExp) => {
  try {
    await run()
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), pattern)
    return
  }
  throw new Error(`expected rejection ${pattern}`)
}

describe("claude types cache", () => {
  it("reuses a verified cache and does not fetch", async () => {
    const dir = temp()
    const cache = path.join(dir, "cache.d.ts")
    const body = bytes("cached-bytes\n")
    fs.writeFileSync(cache, body)
    const expected = sha256(body)
    assert.strictEqual(
      await prepareClaudeTypes({
        cachePath: cache,
        expectedSha256: expected,
        url: "https://example.invalid/types",
        fetch: refused,
      }),
      "reused",
    )
    assert.deepStrictEqual(fs.readFileSync(cache), Buffer.from(body))
  })

  it("fetches when the cache is missing and writes only a matching body", async () => {
    const cache = path.join(temp(), "cache.d.ts")
    const body = bytes("fetched-bytes\n")
    let called = ""
    assert.strictEqual(
      await prepareClaudeTypes({
        cachePath: cache,
        expectedSha256: sha256(body),
        url: "https://example.invalid/types",
        fetch: async (url) => {
          called = url
          return body
        },
      }),
      "acquired",
    )
    assert.strictEqual(called, "https://example.invalid/types")
    assert.strictEqual(fs.readFileSync(cache, "utf8"), "fetched-bytes\n")
  })

  it("drops an unverified cache when the fetch is wrong or unavailable", async () => {
    const dir = temp()
    const cache = path.join(dir, "cache.d.ts")
    const good = bytes("good")
    fs.writeFileSync(cache, "stale")
    await rejects(
      () =>
        prepareClaudeTypes({
          cachePath: cache,
          expectedSha256: sha256(good),
          url: "https://example.invalid/types",
          fetch: async () => bytes("wrong"),
        }),
      /failed checksum/,
    )
    assert.isFalse(fs.existsSync(cache))

    fs.writeFileSync(cache, "stale again")
    await rejects(
      () =>
        prepareClaudeTypes({
          cachePath: cache,
          expectedSha256: sha256(good),
          url: "https://example.invalid/types",
          fetch: async () => Promise.reject(new Error("offline")),
        }),
      /offline/,
    )
    assert.isFalse(fs.existsSync(cache))
  })
})
