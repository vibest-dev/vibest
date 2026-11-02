// The release archive install.sh downloads: `bun scripts/build-archive.ts <platform>-<arch> [outdir]` writes
// <outdir>/vibest-<platform>-<arch>.tar.gz (default dist/release) holding bin/vibest, built for that platform,
// harnesses/ (the plugins it finds beside its bin/), and herdr-plugin/ (not linked; the user links it).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ARCHIVE_ROOTS, copyHerdrPlugin } from "./archive-layout.ts"

const app = path.dirname(import.meta.dir)
const [target, outdir = path.join(app, "dist/release")] = process.argv.slice(2)
if (!target || !/^(darwin|linux)-(arm64|x64)$/.test(target)) {
  console.error("usage: bun scripts/build-archive.ts <darwin|linux>-<arm64|x64> [outdir]")
  process.exit(1)
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-archive-"))
const run = (argv: ReadonlyArray<string>) => {
  const { exitCode } = Bun.spawnSync([...argv], { cwd: app, stdio: ["inherit", "inherit", "inherit"] })
  if (exitCode !== 0) process.exit(exitCode)
}
run(["bun", "scripts/build.ts", path.join(stage, "bin/vibest"), `bun-${target}`])
run(["bun", "scripts/build-harnesses.ts", path.join(stage, "harnesses")])
copyHerdrPlugin(stage, path.join(app, "herdr-plugin"))
fs.mkdirSync(outdir, { recursive: true })
run(["tar", "-czf", path.resolve(outdir, `vibest-${target}.tar.gz`), "-C", stage, ...ARCHIVE_ROOTS])
fs.rmSync(stage, { recursive: true, force: true })
