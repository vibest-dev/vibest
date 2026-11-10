import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")
const noCache = process.argv.includes("--no-cache")
const flagSlots = new Set<number>()
const valueOf = (flag: string, what: string) => {
  const at = process.argv.indexOf(flag)
  if (at === -1) return undefined
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} takes ${what}`)
    process.exit(1)
  }
  flagSlots.add(at).add(at + 1)
  return value
}
const elsewhere = valueOf("--elsewhere", "check ids, comma-separated")
const keepArchive = valueOf("--keep-archive", "a directory")
const keptPacks = valueOf("--packs", "a directory")
const STAGES = ["build", "typecheck", "test", "archive", "pack", "e2e"]
const stages = valueOf("--stage", `stage names from ${STAGES.join(", ")}, comma-separated`)?.split(",") ?? STAGES
const legs = valueOf("--leg", "curl, npm or curl,npm")?.split(",") ?? ["curl", "npm"]
const shard = valueOf("--shard", "k/n")
const unknown = [...stages.filter((s) => !STAGES.includes(s)), ...legs.filter((l) => l !== "curl" && l !== "npm")]
if (unknown.length) {
  console.error(`verify: unknown ${unknown.join(", ")}; stages: ${STAGES.join(", ")}; legs: curl, npm`)
  process.exit(1)
}
const has = (stage: string) => stages.includes(stage)
const curlLeg = has("e2e") && legs.includes("curl")
const npmLeg = has("e2e") && legs.includes("npm")
const only = process.argv.filter((a, i) => i >= 2 && a !== "--no-cache" && !flagSlots.has(i))
const NPM_SMOKE = ["I1", "I2", "U1", "U9", "U10", "H1"]

type Options = { cwd?: string; env?: NodeJS.ProcessEnv }

const gateEnv = noCache ? { ...process.env, TURBO_FORCE: "true" } : process.env

const run = (title: string, argv: ReadonlyArray<string>, options: Options = {}) =>
  new Promise<boolean>((resolve) => {
    const started = Date.now()
    const child = childProcess.spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const out: Array<Buffer> = []
    child.stdout.on("data", (b: Buffer) => out.push(b))
    child.stderr.on("data", (b: Buffer) => out.push(b))
    const done = (ok: boolean, why: string) => {
      console.log(`\n== verify: ${title} (${((Date.now() - started) / 1000).toFixed(1)} s)`)
      process.stdout.write(Buffer.concat(out))
      if (!ok) console.error(`\nverify: ${title} failed (${why})`)
      resolve(ok)
    }
    child.on("error", (e) => done(false, e.message))
    child.on("close", (code, signal) => done(code === 0, `exit ${code ?? signal}`))
  })

const steps = async (list: ReadonlyArray<readonly [string, ReadonlyArray<string>, Options?]>) => {
  for (const [title, argv, options] of list) if (!(await run(title, argv, options))) return false
  return true
}

const all = async (legs: ReadonlyArray<Promise<boolean>>) => {
  if (!(await Promise.all(legs)).every(Boolean)) process.exit(1)
}

const target = `${process.platform}-${process.arch}`
const platform = path.join(root, "packages", `cli-${target}`)
if (!fs.existsSync(platform)) {
  console.error(`verify: no platform package for ${target}`)
  process.exit(1)
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-verify-"))
const release = keepArchive ? path.resolve(keepArchive) : path.join(dir, "release")
const curl = path.join(dir, "curl")
const packs = keptPacks ? path.resolve(keptPacks) : path.join(dir, "packs")
const npm = path.join(dir, "npm")
fs.mkdirSync(packs, { recursive: true })
const tarballsIn = (folder: string) =>
  fs
    .readdirSync(folder)
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => path.join(folder, f))
const packedName = (tarball: string): string =>
  JSON.parse(childProcess.execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" })).name
const alreadyPacked = tarballsIn(packs).length > 0
const toPack = keptPacks
  ? (
      JSON.parse(
        childProcess.execFileSync("pnpm", ["-r", "ls", "--json", "--depth", "-1"], { cwd: root, encoding: "utf8" }),
      ) as Array<{ path: string; private?: boolean }>
    )
      .filter((p) => !p.private)
      .map((p) => p.path)
  : [path.join(root, "packages/cli"), platform]

type Step = readonly [string, ReadonlyArray<string>, Options?]
const archiveSteps: Array<Step> = has("archive")
  ? [
      [
        "build the release archive",
        ["bun", "scripts/build-archive.ts", target, release],
        { cwd: path.join(root, "packages/cli") },
      ],
    ]
  : []
const curlSteps: Array<Step> = curlLeg
  ? [
      [
        "install.sh",
        ["sh", "-c", 'curl -fsSL "$0" | sh', `file://${path.join(root, "packages/cli/install.sh")}`],
        {
          env: {
            ...process.env,
            VIBEST_DOWNLOAD_URL: `file://${release}`,
            VIBEST_INSTALL: path.join(curl, "share"),
            VIBEST_BIN: path.join(curl, "bin"),
          },
        },
      ],
    ]
  : []
if (curlLeg && !has("archive") && !fs.existsSync(path.join(release, `vibest-${target}.tar.gz`))) {
  console.error(`verify: ${release} holds no vibest-${target}.tar.gz to install`)
  process.exit(1)
}
if (has("build") && !(await run("build", ["pnpm", "run", "build"], { env: gateEnv }))) process.exit(1)
await all([
  ...(only.length === 0 && has("typecheck") ? [run("typecheck", ["pnpm", "run", "typecheck"], { env: gateEnv })] : []),
  ...(only.length === 0 && has("test") ? [run("test", ["pnpm", "run", "test"], { env: gateEnv })] : []),
  steps([...archiveSteps, ...curlSteps]),
  (async () => {
    if (has("pack") && !alreadyPacked)
      for (const pkg of toPack)
        if (
          !(await run(`pack ${path.relative(root, pkg)}`, ["pnpm", "pack", "--pack-destination", packs], { cwd: pkg }))
        )
          return false
    if (!npmLeg) return true
    const installed = new Set(["@vibest/cli", `@vibest/cli-${target}`])
    const tarballs = tarballsIn(packs).filter((t) => installed.has(packedName(t)))
    if (tarballs.length !== installed.size) {
      console.error(`verify: ${packs} does not hold exactly one tarball of each of ${[...installed].join(", ")}`)
      return false
    }
    return run(alreadyPacked ? `npm install (from ${packs})` : "npm install", [
      "npm",
      "install",
      "--no-audit",
      "--no-fund",
      "--prefix",
      npm,
      ...tarballs,
    ])
  })(),
])

const layoutOf = (top: string) => {
  const entries = fs
    .readdirSync(top, { recursive: true, withFileTypes: true })
    .map((e) => {
      const rel = path.relative(top, path.join(e.parentPath, e.name))
      return e.isSymbolicLink()
        ? `${rel} -> ${fs.readlinkSync(path.join(top, rel))}`
        : `${rel}${e.isDirectory() ? "/" : ""}`
    })
    .filter((rel) => !rel.startsWith("package-lock.json"))
    .sort()
  return crypto.createHash("sha256").update(entries.join("\n")).digest("hex")
}
const common = childProcess.execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: root,
  encoding: "utf8",
})
const layoutFile = path.join(common.trim(), "vibest-e2e", "npm-layout")
const layout = npmLeg ? layoutOf(npm) : ""
const layoutKnown = fs.existsSync(layoutFile) && fs.readFileSync(layoutFile, "utf8") === layout
const npmChecks = only.length > 0 || noCache ? only : layoutKnown ? NPM_SMOKE : []

const e2e = (method: string, install: string, ids: ReadonlyArray<string>) =>
  run(
    `e2e on the ${method} install${ids === NPM_SMOKE ? ` (smoke: ${ids.join(" ")})` : ""}`,
    [
      "bun",
      "tools/e2e/src/main.ts",
      "--strict",
      ...(noCache ? ["--no-cache"] : []),
      ...(elsewhere ? ["--elsewhere", elsewhere] : []),
      ...(shard ? ["--shard", shard] : []),
      ...ids,
    ],
    {
      env: { ...process.env, VIBEST_E2E_METHOD: method, VIBEST_E2E_INSTALL: install },
    },
  )
const [curlOk, npmOk] = await Promise.all([
  curlLeg ? e2e("curl", curl, only) : true,
  npmLeg ? e2e("npm", npm, npmChecks) : true,
])
if (npmLeg && npmOk && npmChecks.length === 0 && !shard) {
  fs.mkdirSync(path.dirname(layoutFile), { recursive: true })
  fs.writeFileSync(layoutFile, layout)
}
fs.rmSync(dir, { recursive: true, force: true })

const failedLegs = [...(curlOk ? [] : ["curl"]), ...(npmOk ? [] : ["npm"])]
if (failedLegs.length) {
  console.error(`\nverify: failed on the ${failedLegs.join(" and ")} install`)
  process.exit(1)
}
console.log(
  `\nverify: passed.${elsewhere ? ` Not run here, for another machine's verify to prove: ${elsewhere.split(",").join(" ")}.` : ""}`,
)
