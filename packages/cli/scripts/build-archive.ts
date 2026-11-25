import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { findTarget, PLATFORM_TARGETS } from "../src/platform-target.ts"
import { buildBinaries } from "./build.ts"

const app = path.dirname(import.meta.dir)
const [targetId, outdir = path.join(app, "dist/release")] = process.argv.slice(2)
const target = targetId ? findTarget(targetId) : undefined

if (!target) {
  console.error(`usage: bun scripts/build-archive.ts <${PLATFORM_TARGETS.map((t) => t.id).join("|")}> [outdir]`)
  process.exit(1)
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-archive-"))

try {
  const exitCode = await buildBinaries([{ outfile: path.join(stage, "bin/vibest"), target: target.bunTarget }])

  if (exitCode !== 0) process.exit(exitCode)
  fs.chmodSync(path.join(stage, "bin/vibest"), 0o755)
  fs.mkdirSync(outdir, { recursive: true })

  const tar = Bun.spawnSync(["tar", "-czf", path.resolve(outdir, `vibest-${target.id}.tar.gz`), "-C", stage, "bin"], {
    cwd: app,
    stdio: ["inherit", "inherit", "inherit"],
  })

  if (tar.exitCode !== 0) process.exit(tar.exitCode)
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
