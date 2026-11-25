import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import pkg from "../package.json" with { type: "json" }
import { detectPlatformTarget } from "../src/update.ts"
import { ARCHIVE_ROOTS } from "./archive-layout.ts"
import { buildBinaries } from "./build.ts"
import { findTarget, PLATFORM_TARGETS, type PlatformTarget, PRIMARY_TARGETS } from "./targets.ts"

const cliDir = path.dirname(import.meta.dir)
const rawArgs = process.argv.slice(2)

const valueOf = (flag: string): string | undefined => {
  const at = rawArgs.indexOf(flag)

  if (at === -1) return undefined

  return rawArgs[at + 1]
}

const allFlag = rawArgs.includes("--all")
const noBytecode = rawArgs.includes("--no-bytecode")
const packsDir = path.resolve(cliDir, valueOf("--packs") ?? "dist/npm")
const archivesDir = valueOf("--archives") ? path.resolve(cliDir, valueOf("--archives")!) : undefined
const excludeArchives = new Set((valueOf("--exclude-archive") ?? "").split(",").filter(Boolean))
const requestedTargets = valueOf("--target")

const targets: ReadonlyArray<PlatformTarget> = allFlag
  ? PLATFORM_TARGETS
  : (requestedTargets ? requestedTargets.split(",") : [detectPlatformTarget()]).map((id) => {
      const found = findTarget(id)

      if (!found) {
        console.error(`pack: unknown target ${id}; valid targets: ${PLATFORM_TARGETS.map((t) => t.id).join(", ")}`)
        process.exit(1)
      }

      return found
    })

const run = (argv: ReadonlyArray<string>, cwd: string) => {
  const res = childProcess.spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
  })

  if (res.status !== 0) process.exit(res.status ?? 1)
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-pack-"))

try {
  fs.mkdirSync(packsDir, { recursive: true })

  if (archivesDir) fs.mkdirSync(archivesDir, { recursive: true })

  const jobs = targets.map((t) => ({
    outfile: path.join(stage, `cli-${t.id}`, "bin", "vibest"),
    target: t.bunTarget,
  }))

  const buildCode = await buildBinaries(jobs, { noBytecode })

  if (buildCode !== 0) process.exit(buildCode)

  const licensePath = path.join(cliDir, "LICENSE")

  for (const t of targets) {
    const pkgDir = path.join(stage, `cli-${t.id}`)
    const binPath = path.join(pkgDir, "bin", "vibest")
    fs.chmodSync(binPath, 0o755)
    fs.copyFileSync(licensePath, path.join(pkgDir, "LICENSE"))

    const manifest = {
      name: `@vibest/cli-${t.id}`,
      version: pkg.version,
      description: `Compiled vibest binary for ${t.id}.`,
      license: pkg.license,
      repository: { type: "git", url: "git+https://github.com/vibest-dev/vibest.git" },
      os: [t.os],
      cpu: [t.cpu],
      ...(t.libc ? { libc: [t.libc] } : undefined),
      files: ["bin", "LICENSE"],
      publishConfig: { access: "public" },
    }

    fs.writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    run(["pnpm", "pack", "--pack-destination", packsDir], pkgDir)

    if (archivesDir && !excludeArchives.has(t.id)) {
      const out = path.join(archivesDir, `vibest-${t.id}.tar.gz`)
      fs.rmSync(out, { force: true })
      run(["tar", "-czf", out, "-C", pkgDir, ...ARCHIVE_ROOTS], pkgDir)
    }
  }

  const wrapperDir = path.join(stage, "cli")
  fs.mkdirSync(path.join(wrapperDir, "bin"), { recursive: true })
  fs.copyFileSync(path.join(cliDir, "bin", "vibest"), path.join(wrapperDir, "bin", "vibest"))
  fs.chmodSync(path.join(wrapperDir, "bin", "vibest"), 0o755)
  fs.copyFileSync(licensePath, path.join(wrapperDir, "LICENSE"))

  const optionalDependencies = Object.fromEntries(PRIMARY_TARGETS.map((t) => [`@vibest/cli-${t.id}`, pkg.version]))

  const wrapperManifest = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    repository: pkg.repository,
    bin: { vibest: "./bin/vibest" },
    files: ["bin", "LICENSE"],
    type: "module",
    exports: { "./package.json": "./package.json" },
    publishConfig: { access: "public" },
    os: ["darwin", "linux"],
    cpu: ["arm64", "x64"],
    optionalDependencies,
  }

  fs.writeFileSync(path.join(wrapperDir, "package.json"), `${JSON.stringify(wrapperManifest, null, 2)}\n`)
  run(["pnpm", "pack", "--pack-destination", packsDir], wrapperDir)
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
