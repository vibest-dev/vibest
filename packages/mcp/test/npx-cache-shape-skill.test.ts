import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BunServices } from "@effect/platform-bun"
import { ToolOutput } from "@vibest/core/tool-output"
import { Layout } from "@vibest/schema/layout"
import { Mcp } from "@vibest/schema/mcp"
import { SchemaType } from "@vibest/util/schema-type"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { McpMetadataCache } from "../src/metadata-cache.ts"
import { NpxResolver } from "../src/npx-resolver.ts"

const decodeServerName = Schema.decodeUnknownSync(Mcp.ServerName)

const withTempDirAsync = async <A>(fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-mcp-unit-"))

  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("NpxResolver", () => {
  it("resolves cached _npx JS binary directly, caches in vibestHome, and invalidates on exact semver mismatch", async () => {
    await withTempDirAsync(async (root) => {
      const vibestHome = path.join(root, "vibest-home")
      const npmCache = path.join(root, "npm-cache")
      const pkgDir = path.join(npmCache, "_npx", "hash123", "node_modules", "@acme", "mcp-demo")
      fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true })
      const binFile = path.join(pkgDir, "bin", "cli.js")
      fs.writeFileSync(binFile, "#!/usr/bin/env node\nconsole.log('ok')\n", "utf8")
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "@acme/mcp-demo", version: "1.2.3", bin: { "mcp-demo": "./bin/cli.js" } }),
        "utf8",
      )

      const first = await Effect.runPromise(
        NpxResolver.rewriteCommand({
          command: "npx",
          args: ["-y", "@acme/mcp-demo@1.2.3", "--port", "8080"],
          vibestHome,
          npmCacheDir: npmCache,
          populateOnMiss: false,
        }).pipe(Effect.provide(BunServices.layer)),
      )

      expect(first.resolved).toBe(true)
      expect(first.command).toBe("node")
      expect(first.args).toEqual([binFile, "--port", "8080"])
      expect(fs.existsSync(path.join(vibestHome, "cache", "npx-bin-cache.json"))).toBe(true)

      const npmExec = await Effect.runPromise(
        NpxResolver.resolve({
          command: "npm",
          args: ["exec", "--yes", "--package", "@acme/mcp-demo@1.2.3", "--", "mcp-demo", "--flag"],
          vibestHome,
          npmCacheDir: npmCache,
          populateOnMiss: false,
        }).pipe(Effect.provide(BunServices.layer)),
      )

      expect(npmExec).toEqual({ binPath: binFile, extraArgs: ["--flag"], isJs: true })

      const wrongVersion = await Effect.runPromise(
        NpxResolver.resolve({
          command: "npx",
          args: ["-y", "@acme/mcp-demo@2.0.0"],
          vibestHome,
          npmCacheDir: npmCache,
          populateOnMiss: false,
        }).pipe(Effect.provide(BunServices.layer)),
      )

      expect(wrongVersion).toBeUndefined()
    })
  })
})

describe("McpMetadataCache", () => {
  it("never persists private, ttlMs:0, or unfixed-cwd local servers to disk, while persisting shared entries", async () => {
    await withTempDirAsync(async (vibestHome) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* McpMetadataCache.make(vibestHome)
          const serverName = decodeServerName("demo")

          const sampleTool: Mcp.ToolInfo = {
            server: serverName,
            name: "ping",
            description: "Ping tool",
            signature: "{ msg: string; }",
            inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
          }

          const unfixedLocal: Mcp.ServerConfig = { type: "local", command: ["node", "server.js"] }
          const unfixedFp = McpMetadataCache.computeFingerprint({ config: unfixedLocal, resolvedCwd: "/workspace/a" })

          yield* store.set("unfixed", unfixedLocal, {
            fingerprint: unfixedFp,
            cachedAt: Date.now(),
            tools: [sampleTool],
          })

          expect(yield* store.get("unfixed", unfixedFp)).toBeDefined()

          const remoteConfig: Mcp.ServerConfig = { type: "remote", url: "https://mcp.example.com" }
          const remoteFp = McpMetadataCache.computeFingerprint({ config: remoteConfig, credentialId: "cred-1" })

          yield* store.set("private-remote", remoteConfig, {
            fingerprint: remoteFp,
            cachedAt: Date.now(),
            cacheScope: "private",
            tools: [sampleTool],
          })

          yield* store.set("zero-ttl", remoteConfig, {
            fingerprint: remoteFp,
            cachedAt: Date.now(),
            ttlMs: 0,
            tools: [sampleTool],
          })

          yield* store.set("shared-remote", remoteConfig, {
            fingerprint: remoteFp,
            cachedAt: Date.now(),
            cacheScope: "shared",
            ttlMs: 60_000,
            tools: [sampleTool],
          })

          const freshStore = yield* McpMetadataCache.make(vibestHome)
          expect(yield* freshStore.get("unfixed", unfixedFp)).toBeUndefined()
          expect(yield* freshStore.get("private-remote", remoteFp)).toBeUndefined()
          expect(yield* freshStore.get("zero-ttl", remoteFp)).toBeUndefined()
          expect((yield* freshStore.get("shared-remote", remoteFp))?.tools).toHaveLength(1)

          const changedFp = McpMetadataCache.computeFingerprint({ config: remoteConfig, credentialId: "cred-2" })
          expect(changedFp).not.toBe(remoteFp)
          expect(yield* freshStore.get("shared-remote", changedFp)).toBeUndefined()

          yield* store.set("shared-remote", remoteConfig, {
            fingerprint: remoteFp,
            cachedAt: Date.now(),
            ttlMs: 0,
            tools: [{ ...sampleTool, name: "ephemeral_tool" }],
          })

          expect(yield* store.get("shared-remote", remoteFp)).toBeUndefined()
          const reloaded = yield* McpMetadataCache.make(vibestHome)
          expect(yield* reloaded.get("shared-remote", remoteFp)).toBeUndefined()
        }).pipe(Effect.provide(BunServices.layer)),
      )
    })
  })
})

describe("SchemaType unified schemaToType", () => {
  it("renders compact TypeScript signatures including $defs, enums, arrays, and optional properties", () => {
    const rendered = SchemaType.renderToolSignature({
      type: "object",
      $defs: {
        Filter: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
      },
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        mode: { enum: ["fast", "deep"] },
        filters: { type: "array", items: { $ref: "#/$defs/Filter" } },
      },
      required: ["query"],
      additionalProperties: false,
    })

    expect(rendered).toBe(`{ query: string; limit?: number; mode?: "fast" | "deep"; filters?: { tag: string; }[]; }`)

    expect(SchemaType.schemaToType({ allOf: [{ type: "string" }, { type: "number" }] })).toBe("string & number")
    expect(SchemaType.toIdentifier("my-server.v2")).toBe("my_server_v2")
    expect(SchemaType.toIdentifier("default")).toBe("default_")
  })
})

describe("ToolOutput unified exit guard", () => {
  it("truncates oversized call results and resource reads into scratchpadDir with grapheme-safe UTF-8 boundaries", async () => {
    await withTempDirAsync(async (root) => {
      const scratchpadDir = path.join(root, "scratchpad")
      const hugeText = "A".repeat(4096)
      const layoutLayer = Layer.effect(Layout, Layout.make(root)).pipe(Layer.provide(BunServices.layer))
      const toolOutputLayer = ToolOutput.layer.pipe(Layer.provide(Layer.mergeAll(BunServices.layer, layoutLayer)))

      await Effect.runPromise(
        Effect.gen(function* () {
          const toolOutput = yield* ToolOutput.Service

          const guardedCall = yield* toolOutput.truncateCallResult({
            server: "linear",
            tool: "list_issues",
            result: { isError: false, content: [{ type: "text", text: hugeText }] },
            maxBytes: 1024,
            scratchpadDir,
          })

          expect(guardedCall.truncated).toBe(true)
          expect(guardedCall.outputFile).toBeDefined()
          expect(fs.readFileSync(guardedCall.outputFile!, "utf8")).toBe(hugeText)
          const markerBlock = guardedCall.content.find((block) => block.type === "text" && block.text.includes("saved"))
          expect(markerBlock?.type).toBe("text")

          if (markerBlock?.type === "text") {
            expect(markerBlock.text).toContain(guardedCall.outputFile!)
          }

          const guardedResource = yield* toolOutput.truncateResourceResult({
            server: "linear",
            uri: "skill://pdf-processing/SKILL.md",
            result: {
              uri: "skill://pdf-processing/SKILL.md",
              contents: [{ uri: "skill://pdf-processing/SKILL.md", mimeType: "text/markdown", text: hugeText }],
            },
            maxBytes: 1024,
            scratchpadDir,
          })

          expect(guardedResource.truncated).toBe(true)
          expect(guardedResource.outputFile).toBeDefined()
          expect(fs.readFileSync(guardedResource.outputFile!, "utf8")).toBe(hugeText)
          const resMarker = guardedResource.contents.find((item) => item.text?.includes("saved"))
          expect(resMarker?.text).toContain(guardedResource.outputFile!)
        }).pipe(Effect.provide(toolOutputLayer)),
      )

      const emojiCut = ToolOutput.truncateInline("👋🏽👋🏽👋🏽", 12)
      expect(Buffer.byteLength(emojiCut, "utf8")).toBeLessThanOrEqual(12)
      expect(emojiCut.endsWith("…")).toBe(true)
    })
  })

  it("saves binary media blocks to 0o600 files and cleans up tool_* files older than 7 days", async () => {
    await withTempDirAsync(async (root) => {
      const toolOutputDir = path.join(root, ToolOutput.DIRECTORY)
      fs.mkdirSync(toolOutputDir, { recursive: true, mode: 0o700 })

      const oldFile = path.join(toolOutputDir, "tool_old_expired.txt")
      const recentFile = path.join(toolOutputDir, "tool_recent_keep.txt")
      const otherFile = path.join(toolOutputDir, "unrelated_keep.txt")
      fs.writeFileSync(oldFile, "old", "utf8")
      fs.writeFileSync(recentFile, "recent", "utf8")
      fs.writeFileSync(otherFile, "other", "utf8")

      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo)
      fs.utimesSync(recentFile, oneDayAgo, oneDayAgo)
      fs.utimesSync(otherFile, thirtyDaysAgo, thirtyDaysAgo)

      const layoutLayer = Layer.effect(Layout, Layout.make(root)).pipe(Layer.provide(BunServices.layer))
      const toolOutputLayer = ToolOutput.layer.pipe(Layer.provide(Layer.mergeAll(BunServices.layer, layoutLayer)))

      await Effect.runPromise(
        Effect.gen(function* () {
          const toolOutput = yield* ToolOutput.Service
          yield* toolOutput.cleanup()

          expect(fs.existsSync(oldFile)).toBe(false)
          expect(fs.existsSync(recentFile)).toBe(true)
          expect(fs.existsSync(otherFile)).toBe(true)

          const rawBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

          const mediaResult = yield* toolOutput.truncateCallResult({
            server: "vision",
            tool: "screenshot",
            result: {
              isError: false,
              content: [{ type: "media", mimeType: "image/png", data: rawBytes.toString("base64") }],
            },
          })

          expect(mediaResult.outputFile).toBeDefined()
          expect(mediaResult.outputFile!.endsWith(".png")).toBe(true)
          expect(Buffer.compare(fs.readFileSync(mediaResult.outputFile!), rawBytes)).toBe(0)

          if (process.platform !== "win32") {
            expect(fs.statSync(mediaResult.outputFile!).mode & 0o077).toBe(0)
          }

          expect(mediaResult.content[0]?.type).toBe("text")

          if (mediaResult.content[0]?.type === "text") {
            expect(mediaResult.content[0].text).toContain("Binary resource (image/png, 8 bytes) saved to")
          }

          const structuredResult = yield* toolOutput.truncateCallResult({
            server: "analytics",
            tool: "dump",
            result: {
              isError: false,
              content: [{ type: "text", text: "ok" }],
              structured: { huge: "x".repeat(100_000) },
            },
            maxBytes: 1024,
          })

          expect(structuredResult.truncated).toBe(true)
          expect(structuredResult.structured).toBeUndefined()
          expect(structuredResult.outputFile).toBeDefined()
          expect(fs.readFileSync(structuredResult.outputFile!, "utf8")).toContain("x".repeat(10_000))

          const blobResource = yield* toolOutput.truncateResourceResult({
            server: "vision",
            uri: "file:///image.png",
            result: {
              uri: "file:///image.png",
              contents: [{ uri: "file:///image.png", mimeType: "image/png", blob: rawBytes.toString("base64") }],
            },
          })

          expect(blobResource.truncated).toBe(false)
          expect(blobResource.outputFile).toBeDefined()
          expect(blobResource.outputFile!.endsWith(".png")).toBe(true)
          expect(Buffer.compare(fs.readFileSync(blobResource.outputFile!), rawBytes)).toBe(0)
          expect(blobResource.contents[0]?.blob).toBeUndefined()
          expect(blobResource.contents[0]?.text).toContain("Binary resource (image/png, 8 bytes) saved to")
        }).pipe(Effect.provide(toolOutputLayer)),
      )
    })
  })
})
