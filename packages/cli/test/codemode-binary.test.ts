import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import url from "node:url"

import { describe, expect, it } from "vitest"

const cliDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..")
const binary = path.join(cliDir, "dist", "vibest")

const isolatedEnv = (vibestHome: string): NodeJS.ProcessEnv =>
  Object.fromEntries([
    ...Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("VIBEST_")),
    ["VIBEST_HOME", vibestHome],
  ])

const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const stopIsolatedDaemon = (vibestHome: string) => {
  const pidFile = path.join(vibestHome, "vibestd.pid")

  if (!fs.existsSync(pidFile)) return
  const match = /"pid"\s*:\s*(\d+)/.exec(fs.readFileSync(pidFile, "utf8"))

  if (!match) return
  const pid = Number(match[1])

  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }

  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0)
      sleepSync(50)
    } catch {
      return
    }
  }

  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}

describe("compiled vibest binary CodeMode", () => {
  it("executes vibest mcp exec directly from the compiled single binary without external wasm assets", () => {
    expect(fs.existsSync(binary)).toBe(true)
    const vibestHome = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-cm-bin-"))

    try {
      const env = isolatedEnv(vibestHome)

      const execRun = childProcess.spawnSync(binary, ["mcp", "exec", "return 40 + 2"], {
        cwd: vibestHome,
        env,
        encoding: "utf8",
        timeout: 30_000,
      })

      expect(execRun.status, execRun.stderr).toBe(0)
      const parsed = JSON.parse(execRun.stdout) as { readonly ok: boolean; readonly value: number }
      expect(parsed.ok).toBe(true)
      expect(parsed.value).toBe(42)
    } finally {
      stopIsolatedDaemon(vibestHome)
      fs.rmSync(vibestHome, { recursive: true, force: true })
    }
  }, 45_000)
})
