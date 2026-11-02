// Local typecheck cache for the pinned Claude Code declarations. Not shipped, not committed.
// Source: https://github.com/anthropics/claude-code/blob/2eff7a8d21c80be48904f62ebdea36d945d7b504/mods/types/claude-code.d.ts
// Upstream LICENSE.md: © Anthropic PBC. All rights reserved. Commercial terms. This script does not assert a right to redistribute those bytes.
// The file's "Written by Claude Code 2.1.277" header is stale and does not date the pin.
// A verified cache is reused, including one placed there by hand. Otherwise the pinned URL is fetched. No other lookup.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const CLAUDE_TYPES_PIN = "2eff7a8d21c80be48904f62ebdea36d945d7b504"
export const CLAUDE_TYPES_SHA256 = "e51e637fbbebb2a6a49c4bdc3860a251c2ca2295884822dff0f4c3e3ec802163"
export const CLAUDE_TYPES_URL = `https://raw.githubusercontent.com/anthropics/claude-code/${CLAUDE_TYPES_PIN}/mods/types/claude-code.d.ts`
export const CLAUDE_TYPES_CACHE = ".cache/claude-code.d.ts"

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export type PrepareClaudeTypes = {
  readonly cachePath: string
  readonly expectedSha256: string
  readonly url: string
  readonly fetch: (url: string) => Promise<Uint8Array>
}

const readIfVerified = (file: string, expected: string): Uint8Array | undefined => {
  if (!fs.existsSync(file)) return undefined
  const bytes = fs.readFileSync(file)
  return sha256(bytes) === expected ? bytes : undefined
}

/** Verified cache is reused. Anything else is replaced from the pinned URL, or the call fails. */
export const prepareClaudeTypes = async (options: PrepareClaudeTypes): Promise<"reused" | "acquired"> => {
  const expected = options.expectedSha256
  if (readIfVerified(options.cachePath, expected)) return "reused"
  fs.rmSync(options.cachePath, { force: true })
  const fetched = await options.fetch(options.url)
  if (sha256(fetched) !== expected) throw new Error(`claude-code types from ${options.url} failed checksum ${expected}`)
  fs.mkdirSync(path.dirname(options.cachePath), { recursive: true })
  const tmp = `${options.cachePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, fetched)
  fs.renameSync(tmp, options.cachePath)
  if (!readIfVerified(options.cachePath, expected)) {
    fs.rmSync(options.cachePath, { force: true })
    throw new Error("claude-code types cache failed checksum after write")
  }
  return "acquired"
}

const invoked = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  prepareClaudeTypes({
    cachePath: path.join(root, CLAUDE_TYPES_CACHE),
    expectedSha256: CLAUDE_TYPES_SHA256,
    url: CLAUDE_TYPES_URL,
    fetch: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`claude-code types fetch ${url} returned ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    },
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
