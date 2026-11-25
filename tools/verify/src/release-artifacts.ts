import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { detectPlatformTarget, PLATFORM_TARGETS, PRIMARY_TARGETS } from "@vibest/cli/platform-target"
import { Predicate, Schema } from "effect"

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

const published: ReadonlyArray<string> = [
  "@vibest/cli",
  "@vibest/plugin",
  ...PLATFORM_TARGETS.map((t) => `@vibest/cli-${t.id}`),
]

const Dependencies = Schema.optional(Schema.Record(Schema.String, Schema.String))

const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  files: Schema.optional(Schema.Array(Schema.String)),
  bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
  main: Schema.optional(Schema.String),
  exports: Schema.optional(Schema.Json),
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  dependencies: Dependencies,
  optionalDependencies: Dependencies,
  peerDependencies: Dependencies,
})

type Manifest = typeof Manifest.Type

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))

const tarballs = new Map<string, string>()
const manifests = new Map<string, Manifest>()

for (const tgz of fs.readdirSync(packs).filter((f) => f.endsWith(".tgz"))) {
  const tarball = path.join(packs, tgz)

  const files = run(["tar", "-tzf", tarball], dir)
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/^package\//, ""))

  const manifest = decodeManifest(run(["tar", "-xzOf", tarball, "package/package.json"], dir))
  tarballs.set(manifest.name, tarball)
  manifests.set(manifest.name, manifest)

  const has = (pattern: string, what: string) => {
    const p = pattern.replace(/^\.\//, "").replace(/\/$/, "")
    const re = new RegExp(`^${p.split("*").map(escape).join("[^]+")}(/|$)`)

    if (!files.some((f) => re.test(f))) errors.push(`${manifest.name}: ${what} ${pattern} is not in the tarball`)
  }

  if (manifest.version !== version) errors.push(`${manifest.name}: packed version ${manifest.version}, not ${version}`)

  for (const f of manifest.files ?? []) has(f, "files entry")

  for (const f of Predicate.isString(manifest.bin) ? [manifest.bin] : Object.values(manifest.bin ?? {})) has(f, "bin")

  if (manifest.main) has(manifest.main, "main")

  for (const f of targets(manifest.exports)) has(f, "exports target")

  if (manifest.name === "@vibest/cli") {
    has("bin/vibest", "launcher script")

    if (manifest.scripts?.postinstall) errors.push("@vibest/cli: must not declare a postinstall script")

    const expectedOpt = new Set(PRIMARY_TARGETS.map((t) => `@vibest/cli-${t.id}`))
    const actualOpt = new Set(Object.keys(manifest.optionalDependencies ?? {}))

    for (const dep of expectedOpt)
      if (!actualOpt.has(dep)) errors.push(`@vibest/cli: missing optionalDependency ${dep}`)

    for (const dep of actualOpt)
      if (!expectedOpt.has(dep)) errors.push(`@vibest/cli: unexpected optionalDependency ${dep}`)
  }

  if (manifest.name === "@vibest/plugin") {
    for (const f of [
      "README.md",
      "dist/promise/index.js",
      "dist/promise/index.d.ts",
      "dist/effect/index.js",
      "dist/effect/index.d.ts",
    ])
      has(f, "compiled plugin artifact")

    if (files.includes("dist/effect/launch.d.ts"))
      errors.push("@vibest/plugin: internal dist/effect/launch.d.ts must not be published")

    if (manifest.dependencies && "@vibest/schema" in manifest.dependencies)
      errors.push("@vibest/plugin: packed dependencies must not include private @vibest/schema")
  }
}

const missing = published.filter((name) => !tarballs.has(name))

if (missing.length) errors.push(`${packs} holds no tarball of ${missing.join(", ")}`)

const unpublished = [...tarballs.keys()].filter((name) => !published.includes(name))

if (unpublished.length) errors.push(`${packs} holds tarballs of ${unpublished.join(", ")}, which are not published`)

if (tarballs.size !== fs.readdirSync(packs).filter((f) => f.endsWith(".tgz")).length)
  errors.push(`${packs} holds more than one tarball of a package`)

const target = detectPlatformTarget()
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

  console.log(`== npm install --ignore-scripts @vibest/cli and @vibest/cli-${target}`)
  run(
    ["npm", "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, cli, platform],
    dir,
    env,
  )
  const first = run([path.join(prefix, "bin", "vibest"), "--version"], home, env).trim()
  const second = run([path.join(prefix, "bin", "vibest"), "--version"], home, env).trim()
  console.log(`vibest --version: ${first} (2nd: ${second})`)

  if (first !== `vibest v${version}`)
    errors.push(`installed vibest --version (1st) printed "${first}", not "vibest v${version}"`)

  if (second !== `vibest v${version}`)
    errors.push(`installed vibest --version (2nd) printed "${second}", not "vibest v${version}"`)
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

function targets(exports: Schema.Json | undefined): Array<string> {
  if (Predicate.isString(exports)) return [exports]

  if (exports === null || exports === undefined || Predicate.isNumber(exports) || Predicate.isBoolean(exports))
    return []

  return Object.values(exports).flatMap(targets)
}
