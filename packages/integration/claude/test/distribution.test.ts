// The Claude plugin as it is built, checked offline: real `pnpm pack` tarballs (prepack builds them) extracted and
// inspected; they must hold the built module and a manifest stamped with the package version. Only a fake host loads
// the module.
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"

const pkg = path.join(import.meta.dirname, "..")
const repo = path.join(pkg, "../../..")
const FILES = [
  ".claude-plugin/plugin.json",
  "LICENSE",
  "README.md",
  "hooks/hooks.json",
  "hooks/register.mjs",
  "package.json",
]
// What a versioned copy of the package needs to pack. Not the type cache or generated files.
const SOURCES = ["package.json", "src", "scripts", "hooks/hooks.json", "README.md", "LICENSE"]
// Static, dynamic and CommonJS imports, and re-exports. The bundle must need nothing outside itself.
const IMPORT = /\bimport\s*[\s({*"'`]|\brequire\s*\(|\bexport\s[^;]*\bfrom\s*["'`]/
// Claude Code loads `register` only as a top-level function declaration. Bun emits top-level code unindented and
// exports through one trailing list, so both halves are checked: the declaration, and `register` exported.
const REGISTER_DECLARED = /^(export )?function register\(/m
const REGISTER_EXPORTED = /^export (function register\(|\{[^}]*\bregister\b[^}]*\})/m
const EVENTS = [
  "classic.PreToolUse",
  "classic.Stop",
  "classic.StopFailure",
  "classic.UserPromptSubmit",
  "command.run",
  "session.end",
  "session.start",
]

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"))

const listFiles = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => !e.isDirectory())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)) + (e.isSymbolicLink() ? " (symlink)" : ""))
    .sort()

// What is wrong with the extracted package `dir`. Empty when it is installable as is.
const problems = (dir: string): string[] => {
  const out: string[] = []
  const files = listFiles(dir)
  if (files.join() !== FILES.join()) out.push(`files: ${files.join(", ")}`)
  const manifest = readJson(path.join(dir, ".claude-plugin/plugin.json"))
  const version = readJson(path.join(dir, "package.json")).version
  if (manifest.version !== version) out.push(`plugin.json version ${manifest.version} is not package.json ${version}`)
  const hooks = readJson(path.join(dir, "hooks/hooks.json"))
  if (JSON.stringify(hooks.modules) !== '["./register.mjs"]') out.push(`modules: ${JSON.stringify(hooks.modules)}`)
  if ("hooks" in hooks) out.push("command hooks")
  if (files.some((name) => name.endsWith(".sh"))) out.push("shipped sh wrapper")
  const text = fs.readFileSync(path.join(dir, "hooks/register.mjs"), "utf8")
  if (IMPORT.test(text)) out.push("register.mjs imports")
  if (!REGISTER_DECLARED.test(text)) out.push("register.mjs has no top-level function register")
  if (!REGISTER_EXPORTED.test(text)) out.push("register.mjs does not export register")
  return out
}

let tmp: string

const run = (command: string, args: string[], cwd: string) => {
  const r = childProcess.spawnSync(command, args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${r.stderr}${r.stdout}`)
}

// `pnpm pack` of `dir` (prepack enabled), extracted. Returns the extracted package directory.
const pack = (dir: string, name: string) => {
  const out = path.join(tmp, name)
  fs.mkdirSync(out)
  run("pnpm", ["pack", "--pack-destination", out], dir)
  const [tarball] = fs.readdirSync(out)
  run("tar", ["xzf", tarball!], out)
  return path.join(out, "package")
}

// The package's sources copied to a temp dir under another version, as CI's canary or beta versioning leaves it.
const versioned = (version: string) => {
  const dir = path.join(tmp, `src-${version}`)
  for (const name of SOURCES) fs.cpSync(path.join(pkg, name), path.join(dir, name), { recursive: true })
  const manifest = readJson(path.join(dir, "package.json"))
  // Outside the workspace pnpm would otherwise fetch its own latest release; pin the repository's.
  const { packageManager } = readJson(path.join(repo, "package.json"))
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...manifest, version, packageManager }, null, 2))
  return dir
}

const build = (cwd: string, out: string) => run("bun", [path.join(pkg, "scripts/build.ts"), out], cwd)

let packed: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-cpd-"))
  packed = pack(pkg, "packed")
}, 60_000)

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

const fixture = (name: string) => {
  const dir = path.join(tmp, name)
  fs.cpSync(packed, dir, { recursive: true })
  return dir
}

describe("claude plugin distribution", () => {
  it("the manifest names the plugin; its version comes only from package.json", () => {
    assert.strictEqual(readJson(path.join(pkg, "package.json")).name, "@vibest/claude")
    const manifest = readJson(path.join(pkg, "src/manifest.json"))
    assert.strictEqual(manifest.name, "vibest")
    assert.strictEqual(manifest.repository, "https://github.com/iamdin/orchestrate-my-agent-cli")
    assert.notProperty(manifest, "version", "the version comes only from package.json")
  })

  it("the packed package is complete, import-free and stamped with its own version", () => {
    assert.deepStrictEqual(problems(packed), [])
    assert.strictEqual(
      readJson(path.join(packed, ".claude-plugin/plugin.json")).version,
      readJson(path.join(pkg, "package.json")).version,
    )
  })

  it("each package version packs a plugin.json of that version", () => {
    const versions = ["0.0.2-canary.20261026120000.gabc1234", "0.0.2-beta.7"]
    for (const version of versions) {
      const dir = pack(versioned(version), `packed-${version}`)
      assert.deepStrictEqual(problems(dir), [])
      assert.strictEqual(readJson(path.join(dir, "package.json")).version, version)
      assert.strictEqual(readJson(path.join(dir, ".claude-plugin/plugin.json")).version, version)
    }
  }, 60_000)

  it("packs only the allowlisted files, not other files beside them", () => {
    // Synthetic stand-ins: Claude development tooling can generate .claude-plugin/types, Git ignores it, npm must too.
    const dir = versioned("0.0.2-beta.8")
    fs.mkdirSync(path.join(dir, ".claude-plugin/types"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".claude-plugin/types/x.d.ts"), "export {}\n")
    fs.writeFileSync(path.join(dir, "hooks/x.sh"), "#!/bin/sh\n")
    const packedDir = pack(dir, "packed-strays")
    assert.deepStrictEqual(listFiles(packedDir), FILES)
    assert.deepStrictEqual(problems(packedDir), [])
  }, 60_000)

  it("the packed module loads and registers only the native listeners", async () => {
    const plugin = (await import(path.join(packed, "hooks/register.mjs"))) as { register: (on: Function) => void }
    const events: string[] = []
    plugin.register((event: string) => {
      events.push(event)
      return { catch: () => undefined }
    })
    assert.deepStrictEqual(events.sort(), EVENTS)
  })

  it("the tarball's bundle is the bytes a build gives", () => {
    const built = path.join(tmp, "built")
    build(pkg, built)
    assert.deepStrictEqual(
      listFiles(built),
      FILES.filter((name) => name !== "package.json"),
    )
    for (const name of FILES.filter((name) => name !== "package.json"))
      assert.isTrue(fs.readFileSync(path.join(built, name)).equals(fs.readFileSync(path.join(packed, name))), name)
  })

  it("fails on a missing file, a version mismatch, command hooks or a shipped sh wrapper", () => {
    const missing = fixture("missing")
    fs.rmSync(path.join(missing, "README.md"))
    assert.include(problems(missing).join(), "files:")

    const mismatched = fixture("mismatched")
    const manifestFile = path.join(mismatched, ".claude-plugin/plugin.json")
    fs.writeFileSync(manifestFile, JSON.stringify({ ...readJson(manifestFile), version: "0.0.0" }))
    assert.include(problems(mismatched).join(), "plugin.json version 0.0.0")

    const commanded = fixture("commanded")
    const hooksFile = path.join(commanded, "hooks/hooks.json")
    const hooks = readJson(hooksFile) as Record<string, unknown>
    hooks.hooks = { Stop: [{ hooks: [{ type: "command", command: "bash vibest-hook.sh stop" }] }] }
    fs.writeFileSync(hooksFile, JSON.stringify(hooks))
    assert.include(problems(commanded), "command hooks")

    const wrapped = fixture("wrapped")
    fs.writeFileSync(path.join(wrapped, "hooks/vibest-hook.sh"), "#!/bin/sh\n")
    assert.include(problems(wrapped), "shipped sh wrapper")
  })

  it("fails on a register that is not a declared, exported function", () => {
    const arrow = fixture("arrow")
    const arrowFile = path.join(arrow, "hooks/register.mjs")
    fs.writeFileSync(
      arrowFile,
      fs
        .readFileSync(arrowFile, "utf8")
        .replace(/^function register\(on, _options\)/m, "var register = (on, _options) =>"),
    )
    assert.include(problems(arrow), "register.mjs has no top-level function register")

    const unexported = fixture("unexported")
    const unexportedFile = path.join(unexported, "hooks/register.mjs")
    fs.writeFileSync(
      unexportedFile,
      fs.readFileSync(unexportedFile, "utf8").replace(/^(export \{[^}]*)\bregister\b/m, "$1"),
    )
    assert.include(problems(unexported), "register.mjs does not export register")
  })

  it("builds the same bytes from any working directory, and resolves a relative output against it", () => {
    const elsewhere = path.join(tmp, "elsewhere")
    fs.mkdirSync(elsewhere)
    build(elsewhere, "relative-out")
    build(os.tmpdir(), path.join(tmp, "from-tmpdir"))
    for (const out of [path.join(elsewhere, "relative-out"), path.join(tmp, "from-tmpdir")])
      assert.isTrue(
        fs
          .readFileSync(path.join(out, "hooks/register.mjs"))
          .equals(fs.readFileSync(path.join(packed, "hooks/register.mjs"))),
        out,
      )
    assert.isFalse(fs.existsSync(path.join(pkg, "relative-out")), "not resolved against the package")
  })

  it("the import check catches what it looks for", () => {
    for (const code of ['import x from "y"', 'import("y")', 'require("y")', 'export { x } from "y"'])
      assert.isTrue(IMPORT.test(code), code)
  })

  it("the official-type source still bundles to import-free JS", () => {
    const source = fs.readFileSync(path.join(pkg, "src/plugin.ts"), "utf8")
    assert.match(source, /import type \{[^}]*\bRegister\b[^}]*\} from "claude-code"/)
    assert.include(source, "2eff7a8d21c80be48904f62ebdea36d945d7b504")
    const bundle = fs.readFileSync(path.join(packed, "hooks/register.mjs"), "utf8")
    assert.isFalse(IMPORT.test(bundle))
    assert.match(bundle, /on\("classic\.Stop"/)
    assert.match(bundle, /on\("classic\.StopFailure"/)
    assert.match(bundle, /on\("classic\.UserPromptSubmit"/)
    assert.match(bundle, /on\("classic\.PreToolUse"/)
    assert.notMatch(bundle, /vibest-hook\.sh|VIBEST_COMMAND/)
  })
})
