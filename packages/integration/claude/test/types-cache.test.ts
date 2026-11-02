// The Claude types cache: reuse a verified file, or fetch the pinned URL. No upstream declaration body is stored here.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { CLAUDE_TYPES_PIN, CLAUDE_TYPES_SHA256, CLAUDE_TYPES_URL, prepareClaudeTypes, sha256 } from "../scripts/prepare-claude-types.ts"

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
      await prepareClaudeTypes({ cachePath: cache, expectedSha256: expected, url: "https://example.invalid/types", fetch: refused }),
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
      () => prepareClaudeTypes({ cachePath: cache, expectedSha256: sha256(good), url: "https://example.invalid/types", fetch: async () => bytes("wrong") }),
      /failed checksum/,
    )
    assert.isFalse(fs.existsSync(cache))

    fs.writeFileSync(cache, "stale again")
    await rejects(
      () => prepareClaudeTypes({
        cachePath: cache,
        expectedSha256: sha256(good),
        url: "https://example.invalid/types",
        fetch: async () => Promise.reject(new Error("offline")),
      }),
      /offline/,
    )
    assert.isFalse(fs.existsSync(cache))
  })

  it("pins the public declaration and the typecheck runs that check before the plugin project", () => {
    assert.strictEqual(CLAUDE_TYPES_PIN, "2eff7a8d21c80be48904f62ebdea36d945d7b504")
    assert.strictEqual(CLAUDE_TYPES_SHA256, "e51e637fbbebb2a6a49c4bdc3860a251c2ca2295884822dff0f4c3e3ec802163")
    assert.strictEqual(CLAUDE_TYPES_URL, `https://raw.githubusercontent.com/anthropics/claude-code/${CLAUDE_TYPES_PIN}/mods/types/claude-code.d.ts`)
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8")) as { scripts: { typecheck: string } }
    assert.match(pkg.scripts.typecheck, /bun scripts\/prepare-claude-types\.ts &&/)
    assert.match(pkg.scripts.typecheck, /&& tsrs --noEmit --fast -p tsconfig\.plugin\.json$/)
    assert.notMatch(pkg.scripts.typecheck, /prepare-claude-types\.ts\s*\|\|/)
    const ignored = fs.readFileSync(path.join(import.meta.dirname, "../../../../.gitignore"), "utf8")
    assert.include(ignored, "packages/integration/claude/.cache/")
    assert.include(ignored, "packages/cli/.cache/", "a cache left by the old CLI typecheck stays ignored")
    assert.notMatch(fs.readFileSync(path.join(import.meta.dirname, "../scripts/prepare-claude-types.ts"), "utf8"), /VIBEST_CLAUDE_TYPES_SEED|eeb174a4-docs/)
  })
})
