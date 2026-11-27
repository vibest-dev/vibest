import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, it } from "@effect/vitest"

import { detectPlatformTarget } from "../src/platform-target.ts"

const launcherSource = path.join(import.meta.dirname, "..", "bin", "vibest")
const target = detectPlatformTarget()

const setupMockInstall = (cliPkgJson: string, targetPkgJson?: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-launcher-"))
  const cliDir = path.join(root, "node_modules", "@vibest", "cli")
  const cliBin = path.join(cliDir, "bin", "vibest")
  fs.mkdirSync(path.dirname(cliBin), { recursive: true })
  fs.copyFileSync(launcherSource, cliBin)
  fs.chmodSync(cliBin, 0o755)
  fs.writeFileSync(path.join(cliDir, "package.json"), cliPkgJson)

  if (targetPkgJson !== undefined) {
    const platDir = path.join(root, "node_modules", "@vibest", `cli-${target}`)
    const platBin = path.join(platDir, "bin", "vibest")
    fs.mkdirSync(path.dirname(platBin), { recursive: true })
    fs.writeFileSync(platBin, "#!/bin/sh\necho RAN_NATIVE_BINARY\n", { mode: 0o755 })
    fs.writeFileSync(path.join(platDir, "package.json"), targetPkgJson)
  }

  return { root, cliBin }
}

it("bin/vibest fails closed on compact single-line package.json version mismatch", () => {
  const { root, cliBin } = setupMockInstall(
    '{"name":"@vibest/cli","version":"0.0.9"}',
    `{"name":"@vibest/cli-${target}","version":"0.0.8"}`,
  )

  try {
    const res = childProcess.spawnSync(cliBin, ["--version"], { encoding: "utf8" })
    assert.notStrictEqual(res.status, 0)
    assert.include(res.stderr, `@vibest/cli-${target}@0.0.8 does not match @vibest/cli@0.0.9`)
    assert.notInclude(res.stdout, "RAN_NATIVE_BINARY")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it("bin/vibest omits trailing @ in install hint when cli version is missing", () => {
  const { root, cliBin } = setupMockInstall('{"name":"@vibest/cli"}')

  try {
    const res = childProcess.spawnSync(cliBin, ["--version"], { encoding: "utf8" })
    assert.notStrictEqual(res.status, 0)
    assert.include(res.stderr, `@vibest/cli-${target}`)
    assert.notInclude(res.stderr, `@vibest/cli-${target}@`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
