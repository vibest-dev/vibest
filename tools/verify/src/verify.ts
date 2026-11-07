import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")
const only = process.argv.slice(2)

const failedLegs: Array<string> = []

const attempt = (
  title: string,
  argv: ReadonlyArray<string>,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) => {
  console.log(`\n== verify: ${title}`)
  const r = childProcess.spawnSync(argv[0]!, argv.slice(1), {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: "inherit",
  })
  if (r.status === 0) return true
  console.error(`\nverify: ${title} failed (${r.error?.message ?? `exit ${r.status ?? r.signal}`})`)
  return false
}

const step = (title: string, argv: ReadonlyArray<string>, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  if (!attempt(title, argv, options)) process.exit(1)
}

if (only.length === 0) {
  step("build", ["pnpm", "run", "build"])
  step("typecheck", ["pnpm", "run", "typecheck"])
  step("test", ["pnpm", "run", "test"])
}

const target = `${process.platform}-${process.arch}`
const platform = path.join(root, "packages", `cli-${target}`)
if (!fs.existsSync(platform)) {
  console.error(`verify: no platform package for ${target}`)
  process.exit(1)
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-verify-"))
const e2e = (method: string, install: string) => {
  const ok = attempt(`e2e on the ${method} install`, ["bun", "tools/e2e/src/main.ts", "--strict", ...only], {
    env: { ...process.env, VIBEST_E2E_METHOD: method, VIBEST_E2E_INSTALL: install },
  })
  if (!ok) failedLegs.push(method)
}

const release = path.join(dir, "release")
const curl = path.join(dir, "curl")
step("build the release archive", ["bun", "scripts/build-archive.ts", target, release], {
  cwd: path.join(root, "apps/vibest-herdr"),
})
step("install.sh", ["sh", "-c", 'curl -fsSL "$0" | sh', `file://${path.join(root, "apps/vibest-herdr/install.sh")}`], {
  env: {
    ...process.env,
    VIBEST_DOWNLOAD_URL: `file://${release}`,
    VIBEST_INSTALL: path.join(curl, "share"),
    VIBEST_BIN: path.join(curl, "bin"),
  },
})
e2e("curl", curl)

const packs = path.join(dir, "packs")
fs.mkdirSync(packs)
for (const pkg of [path.join(root, "apps/vibest-herdr"), platform])
  step(`pack ${path.relative(root, pkg)}`, ["pnpm", "pack", "--pack-destination", packs], { cwd: pkg })
const npm = path.join(dir, "npm")
const tarballs = fs.readdirSync(packs).map((f) => path.join(packs, f))
step("npm install", ["npm", "install", "--no-audit", "--no-fund", "--prefix", npm, ...tarballs])
e2e("npm", npm)
fs.rmSync(dir, { recursive: true, force: true })

if (failedLegs.length) {
  console.error(`\nverify: failed on the ${failedLegs.join(" and ")} install`)
  process.exit(1)
}
console.log("\nverify: passed.")
if (only.length === 0) {
  const manual: Array<string> = []
  let section = ""
  for (const line of fs.readFileSync(path.join(root, "docs/testing/feature-map.md"), "utf8").split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3)
    const m = /^\| [A-Z]+\d+ +\| (.+?) \| (agent|runtime|slow) +\|/.exec(line)
    if (m)
      manual.push(
        `  ${section}: ${m[1]!.trim().replaceAll("`", "")}${{ agent: " (an agent checks it: pnpm e2e --tier agent)", slow: " (pnpm e2e --tier slow)", runtime: " (needs the Agent runtime)" }[m[2]!]}`,
      )
  }
  if (manual.length) console.log(`Not proven by a script (docs/testing/feature-map.md):\n${manual.join("\n")}`)
}
