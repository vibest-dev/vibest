import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")
const [version, flag, flagDir] = process.argv.slice(2)
if (!version || flag !== "--from" || !flagDir) {
  console.error("usage: bun tools/verify/src/release-artifacts.ts <version> --from <dir>")
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
const packs = path.resolve(flagDir)
const published: Array<string> = JSON.parse(run(["pnpm", "-r", "ls", "--json", "--depth", "-1"], root))
  .filter((p: { private?: boolean }) => !p.private)
  .map((p: { name: string }) => p.name)

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
    for (const f of [
      "harnesses/claude/.claude-plugin/plugin.json",
      "harnesses/claude/hooks/hooks.json",
      "harnesses/cursor/.cursor-plugin/plugin.json",
      "harnesses/cursor/hooks/hooks.json",
      "harnesses/cursor/index.js",
      "harnesses/pi/extension.mjs",
      "harnesses/claude/skills/*/SKILL.md",
      "harnesses/cursor/skills/*/SKILL.md",
      "harnesses/pi/skills/*/SKILL.md",
    ])
      has(f, "harness plugin file")
  }
}
const missing = published.filter((name) => !tarballs.has(name))
if (missing.length) errors.push(`${packs} holds no tarball of ${missing.join(", ")}`)
const unpublished = [...tarballs.keys()].filter((name) => !published.includes(name))
if (unpublished.length) errors.push(`${packs} holds tarballs of ${unpublished.join(", ")}, which are not published`)
if (tarballs.size !== fs.readdirSync(packs).filter((f) => f.endsWith(".tgz")).length)
  errors.push(`${packs} holds more than one tarball of a package`)

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

{
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
  const publishOrder = order.map((name) => `${name} ${path.basename(tarballs.get(name)!)}\n`).join("")
  const orderFile = path.join(packs, "publish-order")
  if (!fs.existsSync(orderFile)) fs.writeFileSync(orderFile, publishOrder)
  else if (fs.readFileSync(orderFile, "utf8") !== publishOrder)
    errors.push(`${orderFile} is not the publish order of the tarballs ${packs} holds`)
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
