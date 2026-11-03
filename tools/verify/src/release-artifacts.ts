// `bun tools/verify/src/release-artifacts.ts <version> [--out <dir> | --from <dir>]`: the Release workflow's check of
// what it publishes, before Publish. It packs every published workspace package (pnpm pack), or with --from takes the
// tarballs an earlier --out run packed into <dir>; checks each tarball holds what its packed package.json declares
// (files, bin, main, exports; for @vibest/cli the harness plugins); then installs the packed @vibest/cli and this
// platform's binary package into an empty npm prefix outside the checkout and checks that `vibest --version` prints
// <version>. With --out the checked tarballs stay in <dir>, with `publish-order` listing them dependencies first, one
// "<name> <file>" per line: what Publish publishes. No harness, no model, no secrets.
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")
const [version, flag, flagDir] = process.argv.slice(2)
if (!version || (flag !== undefined && !((flag === "--out" || flag === "--from") && flagDir))) {
  console.error("usage: bun tools/verify/src/release-artifacts.ts <version> [--out <dir> | --from <dir>]")
  process.exit(1)
}

const errors: Array<string> = []
const run = (argv: ReadonlyArray<string>, cwd: string, env: NodeJS.ProcessEnv = process.env) => {
  const r = childProcess.spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  })
  if (r.status !== 0) {
    console.error(r.stdout)
    console.error(`release-artifacts: ${argv.join(" ")} failed (${r.error?.message ?? `exit ${r.status ?? r.signal}`})`)
    process.exit(1)
  }
  return r.stdout
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-release-"))
const packs = flagDir ? path.resolve(flagDir) : path.join(dir, "packs")
fs.mkdirSync(packs, { recursive: true })

if (flag !== "--from") {
  if (fs.readdirSync(packs).length) {
    console.error(`release-artifacts: ${packs} is not empty`)
    process.exit(1)
  }
  // The workspace packages to publish: every one not private.
  const published: Array<string> = JSON.parse(run(["pnpm", "-r", "ls", "--json", "--depth", "-1"], root))
    .filter((p: { private?: boolean }) => !p.private)
    .map((p: { path: string }) => p.path)
  for (const pkg of published) {
    console.log(`== pack ${path.relative(root, pkg)}`)
    run(["pnpm", "pack", "--pack-destination", packs], pkg)
  }
}

type Manifest = Record<string, any>
const tarballs = new Map<string, string>()
const manifests = new Map<string, Manifest>()
for (const tgz of fs.readdirSync(packs).filter((f) => f.endsWith(".tgz"))) {
  const tarball = path.join(packs, tgz)
  const files = run(["tar", "-tzf", tarball], dir)
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/^package\//, ""))
  const manifest: Manifest = JSON.parse(run(["tar", "-xzOf", tarball, "package/package.json"], dir))
  tarballs.set(manifest.name, tarball)
  manifests.set(manifest.name, manifest)
  const has = (pattern: string, what: string) => {
    const p = pattern.replace(/^\.\//, "").replace(/\/$/, "")
    const re = new RegExp(`^${p.split("*").map(escape).join("[^]+")}(/|$)`)
    if (!files.some((f) => re.test(f))) errors.push(`${manifest.name}: ${what} ${pattern} is not in the tarball`)
  }
  if (manifest.version !== version) errors.push(`${manifest.name}: packed version ${manifest.version}, not ${version}`)
  for (const f of manifest.files ?? []) has(f, "files entry")
  for (const f of typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {}))
    has(f as string, "bin")
  if (manifest.main) has(manifest.main, "main")
  for (const f of targets(manifest.exports)) has(f, "exports target")
  if (manifest.name === "@vibest/cli") {
    // What the binary starts each harness with (packages/core/src/harnesses/), and each harness's skills.
    for (const f of [
      "harnesses/claude/.claude-plugin/plugin.json",
      "harnesses/claude/hooks/hooks.json",
      "harnesses/cursor/.cursor-plugin/plugin.json",
      "harnesses/cursor/hooks/hooks.json",
      "harnesses/pi/extension.mjs",
      "harnesses/claude/skills/*/SKILL.md",
      "harnesses/cursor/skills/*/SKILL.md",
      "harnesses/pi/skills/*/SKILL.md",
    ])
      has(f, "harness plugin file")
  }
}
if (flag === "--from") {
  // Exactly the tarballs publish-order lists: nothing missing, nothing extra.
  const listed = fs
    .readFileSync(path.join(packs, "publish-order"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[1])
  const found = [...tarballs.values()].map((f) => path.basename(f))
  if (listed.sort().join() !== found.sort().join())
    errors.push(`publish-order lists ${listed.join(", ")}; ${packs} holds ${found.join(", ")}`)
}

// npm, as `npm i -g @vibest/cli` installs it: only the two tarballs, from an empty directory outside the checkout.
const target = `${process.platform}-${process.arch}`
const platform = tarballs.get(`@vibest/cli-${target}`)
const cli = tarballs.get("@vibest/cli")
if (!platform || !cli) errors.push(`no packed @vibest/cli or @vibest/cli-${target}`)
else {
  const prefix = path.join(dir, "npm")
  const home = path.join(dir, "home")
  fs.mkdirSync(home)
  const env = {
    ...process.env,
    HOME: home,
    VIBEST_HOME: path.join(home, ".vibest"),
    npm_config_cache: path.join(dir, "npm-cache"),
  }
  console.log(`== npm install @vibest/cli and @vibest/cli-${target}`)
  run(["npm", "install", "--global", "--no-audit", "--no-fund", "--prefix", prefix, cli, platform], dir, env)
  const out = run([path.join(prefix, "bin", "vibest"), "--version"], home, env).trim()
  console.log(`vibest --version: ${out}`)
  if (out !== `vibest v${version}`) errors.push(`installed vibest --version printed "${out}", not "vibest v${version}"`)
}

if (flag === "--out") {
  // Dependencies first: a package's dependencies, optional and peer dependencies among the published ones before it.
  const order: Array<string> = []
  const visit = (name: string, chain: ReadonlyArray<string>) => {
    if (order.includes(name)) return
    if (chain.includes(name)) return void errors.push(`dependency cycle: ${[...chain, name].join(" -> ")}`)
    const m = manifests.get(name)!
    for (const dep of Object.keys({ ...m.dependencies, ...m.optionalDependencies, ...m.peerDependencies }))
      if (manifests.has(dep)) visit(dep, [...chain, name])
    order.push(name)
  }
  for (const name of [...manifests.keys()].sort()) visit(name, [])
  fs.writeFileSync(
    path.join(packs, "publish-order"),
    order.map((name) => `${name} ${path.basename(tarballs.get(name)!)}\n`).join(""),
  )
}

fs.rmSync(dir, { recursive: true, force: true })
if (errors.length) {
  console.error(`release-artifacts: failed\n  ${errors.join("\n  ")}`)
  process.exit(1)
}
console.log(`release-artifacts: ${tarballs.size} packages checked, vibest v${version} runs on ${target}`)

function escape(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
}
function targets(exports: unknown): Array<string> {
  if (typeof exports === "string") return [exports]
  if (exports && typeof exports === "object") return Object.values(exports).flatMap(targets)
  return []
}
