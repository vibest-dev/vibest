import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Mcp } from "@vibest/schema/mcp"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { McpMetadataCache } from "../src/metadata-cache.ts"
import { NpxResolver } from "../src/npx-resolver.ts"
import { McpSkillSync } from "../src/skill-sync.ts"
// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- testing required public API
import { renderToolSignature, renderTsShape } from "../src/ts-shape.ts"

const decodeServerName = Schema.decodeUnknownSync(Mcp.ServerName)

const withTempDir = <A>(fn: (dir: string) => A): A => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-mcp-unit-"))

  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

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
        }),
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
        }),
      )

      expect(npmExec).toEqual({ binPath: binFile, extraArgs: ["--flag"], isJs: true })

      const wrongVersion = await Effect.runPromise(
        NpxResolver.resolve({
          command: "npx",
          args: ["-y", "@acme/mcp-demo@2.0.0"],
          vibestHome,
          npmCacheDir: npmCache,
          populateOnMiss: false,
        }),
      )

      expect(wrongVersion).toBeUndefined()
    })
  })
})

describe("McpMetadataCache", () => {
  it("never persists private, ttlMs:0, or unfixed-cwd local servers to disk, while persisting shared entries", () => {
    withTempDir((vibestHome) => {
      const store = McpMetadataCache.make(vibestHome)
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

      store.set("unfixed", unfixedLocal, {
        fingerprint: unfixedFp,
        cachedAt: Date.now(),
        tools: [sampleTool],
      })

      expect(store.get("unfixed", unfixedFp)).toBeDefined()

      const remoteConfig: Mcp.ServerConfig = { type: "remote", url: "https://mcp.example.com" }
      const remoteFp = McpMetadataCache.computeFingerprint({ config: remoteConfig, credentialId: "cred-1" })

      store.set("private-remote", remoteConfig, {
        fingerprint: remoteFp,
        cachedAt: Date.now(),
        cacheScope: "private",
        tools: [sampleTool],
      })

      store.set("zero-ttl", remoteConfig, {
        fingerprint: remoteFp,
        cachedAt: Date.now(),
        ttlMs: 0,
        tools: [sampleTool],
      })

      store.set("shared-remote", remoteConfig, {
        fingerprint: remoteFp,
        cachedAt: Date.now(),
        cacheScope: "shared",
        ttlMs: 60_000,
        tools: [sampleTool],
      })

      const freshStore = McpMetadataCache.make(vibestHome)
      expect(freshStore.get("unfixed", unfixedFp)).toBeUndefined()
      expect(freshStore.get("private-remote", remoteFp)).toBeUndefined()
      expect(freshStore.get("zero-ttl", remoteFp)).toBeUndefined()
      expect(freshStore.get("shared-remote", remoteFp)?.tools).toHaveLength(1)

      const changedFp = McpMetadataCache.computeFingerprint({ config: remoteConfig, credentialId: "cred-2" })
      expect(changedFp).not.toBe(remoteFp)
      expect(freshStore.get("shared-remote", changedFp)).toBeUndefined()

      store.set("shared-remote", remoteConfig, {
        fingerprint: remoteFp,
        cachedAt: Date.now(),
        ttlMs: 0,
        tools: [{ ...sampleTool, name: "ephemeral_tool" }],
      })

      expect(store.get("shared-remote", remoteFp)).toBeUndefined()
      expect(McpMetadataCache.make(vibestHome).get("shared-remote", remoteFp)).toBeUndefined()
    })
  })
})

describe("renderTsShape", () => {
  it("renders compact TypeScript signatures including $defs, enums, arrays, and optional properties", () => {
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- testing required public API
    const rendered = renderTsShape({
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

    expect(rendered).toBe(
      `type Filter = { tag: string; };\n\n{ query: string; limit?: number; mode?: "fast" | "deep"; filters?: Filter[]; }`,
    )

    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- testing required public API
    expect(renderTsShape({ allOf: [{ type: "string" }] })).toBeNull()
    expect(renderToolSignature({ allOf: [{ type: "string" }] })).toBe("Record<string, unknown>")
  })
})

describe("McpSkillSync & scratchpad overflow guard", () => {
  it("compiles SKILL.md for skill-exposed servers, removes stale dirs, and guards oversized call results", () => {
    withTempDir((root) => {
      const skillsRoot = path.join(root, "skills")
      const staleDir = path.join(skillsRoot, "mcp-removed")
      fs.mkdirSync(staleDir, { recursive: true })
      fs.writeFileSync(path.join(staleDir, "SKILL.md"), "stale", "utf8")

      const server = decodeServerName("linear")

      const synced = McpSkillSync.syncSkillsToDirectory({
        skillsRoot,
        servers: [
          {
            server,
            exposure: "skill",
            title: "Linear",
            instructions: "Use Linear tools for issue tracking.",
            tools: [
              {
                server,
                name: "list_issues",
                description: "List issues in a team\nMore details on line 2.",
                signature: "{ team: string; limit?: number; }",
                inputSchema: { type: "object" },
              },
            ],
          },
          {
            server: decodeServerName("direct-only"),
            exposure: "direct",
            tools: [],
          },
        ],
      })

      expect(synced.synced).toHaveLength(1)
      expect(synced.removed).toEqual([staleDir])
      expect(fs.existsSync(staleDir)).toBe(false)

      const content = fs.readFileSync(synced.synced[0]!.skillPath, "utf8")
      expect(content).toContain("name: mcp-linear")
      expect(content).toContain("Use Linear tools for issue tracking.")
      expect(content).toContain("`list_issues({ team: string; limit?: number; })` — List issues in a team")
      expect(content).toContain("vibest mcp describe linear <tool>")
      expect(content).toContain("vibest mcp call linear <tool> '<json>'")

      const scratchpadDir = path.join(root, "scratchpad")
      const hugeText = "A".repeat(4096)

      const guarded = McpSkillSync.guardCallResult({
        server: "linear",
        tool: "list_issues",
        result: { isError: false, content: [{ type: "text", text: hugeText }] },
        maxBytes: 1024,
        scratchpadDir,
      })

      expect(guarded.truncated).toBe(true)
      expect(guarded.outputFile).toBeDefined()
      expect(fs.readFileSync(guarded.outputFile!, "utf8")).toBe(hugeText)
      expect(guarded.content[0]?.type).toBe("text")

      if (guarded.content[0]?.type === "text") {
        expect(guarded.content[0].text).toContain(guarded.outputFile!)
      }
    })
  })
})
