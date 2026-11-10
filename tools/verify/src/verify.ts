import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")
const noCache = process.argv.includes("--no-cache")
const elsewhereAt = process.argv.indexOf("--elsewhere")
const elsewhere = elsewhereAt === -1 ? undefined : process.argv[elsewhereAt + 1]
if (elsewhere === undefined && elsewhereAt !== -1) {
  console.error("--elsewhere takes check ids, comma-separated")
  process.exit(1)
}
const only = process.argv
  .slice(2)
  .filter((a, i) => a !== "--no-cache" && i + 2 !== elsewhereAt && i + 2 !== elsewhereAt + 1)
const NPM_SMOKE = ["I1", "I2", "U1", "U9", "U10", "H1"]

type Options = { cwd?: string; env?: NodeJS.ProcessEnv }

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
const release = path.join(dir, "release")
const curl = path.join(dir, "curl")
const packs = path.join(dir, "packs")
const npm = path.join(dir, "npm")
fs.mkdirSync(packs)

if (!(await run("build", ["pnpm", "run", "build"]))) process.exit(1)
await all([
  ...(only.length === 0 ? [run("typecheck", ["pnpm", "run", "typecheck"]), run("test", ["pnpm", "run", "test"])] : []),
  steps([
    [
      "build the release archive",
      ["bun", "scripts/build-archive.ts", target, release],
      { cwd: path.join(root, "packages/cli") },
    ],
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
  ]),
  (async () => {
    for (const pkg of [path.join(root, "packages/cli"), platform])
      if (!(await run(`pack ${path.relative(root, pkg)}`, ["pnpm", "pack", "--pack-destination", packs], { cwd: pkg })))
        return false
    const tarballs = fs.readdirSync(packs).map((f) => path.join(packs, f))
    return run("npm install", ["npm", "install", "--no-audit", "--no-fund", "--prefix", npm, ...tarballs])
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
const layout = layoutOf(npm)
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
      ...ids,
    ],
    {
      env: { ...process.env, VIBEST_E2E_METHOD: method, VIBEST_E2E_INSTALL: install },
    },
  )
const [curlOk, npmOk] = await Promise.all([e2e("curl", curl, only), e2e("npm", npm, npmChecks)])
if (npmOk && npmChecks.length === 0) {
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
