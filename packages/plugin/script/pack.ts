import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import util from "node:util"

import pkg from "../package.json" with { type: "json" }

const pluginDir = path.dirname(import.meta.dir)
const repoRoot = path.resolve(pluginDir, "../..")
const schemaDir = path.join(repoRoot, "packages/schema")
const distDir = path.join(pluginDir, "dist")

const { values } = util.parseArgs({
  args: process.argv.slice(2),
  options: {
    packs: { type: "string", default: "dist/npm" },
  },
})

const packsDir = path.resolve(pluginDir, values.packs)

const run = (argv: ReadonlyArray<string>, cwd: string) => {
  const res = Bun.spawnSync([...argv], { cwd, stdio: ["inherit", "inherit", "inherit"] })

  if (res.exitCode !== 0) process.exit(res.exitCode)
}

const collectFiles = (dir: string, out: Array<string> = []): Array<string> => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) collectFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }

  return out
}

const rewriteSchemaImports = (file: string, schemaOutDir: string) => {
  const source = fs.readFileSync(file, "utf8")
  const dir = path.dirname(file)

  const toRel = (subpath: string) => {
    const target = path.join(schemaOutDir, `${subpath}.js`)
    const rel = path.relative(dir, target).split(path.sep).join("/")

    return rel.startsWith(".") ? rel : `./${rel}`
  }

  const rewritten = source
    .replaceAll(
      /(from\s+["'])@vibest\/schema\/([^"']+)(["'])/g,
      (_, pre: string, sub: string, post: string) => `${pre}${toRel(sub)}${post}`,
    )
    .replaceAll(
      /(import\(["'])@vibest\/schema\/([^"']+)(["']\))/g,
      (_, pre: string, sub: string, post: string) => `${pre}${toRel(sub)}${post}`,
    )

  if (rewritten !== source) fs.writeFileSync(file, rewritten)
}

const tscBin = path.join(repoRoot, "node_modules/.bin/tsc")
const schemaOutDir = path.join(distDir, "_schema")
const tmpConfigs = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-plugin-pack-"))

fs.rmSync(distDir, { recursive: true, force: true })

fs.mkdirSync(distDir, { recursive: true })

fs.mkdirSync(packsDir, { recursive: true })

try {
  const bundled = await Bun.build({
    entrypoints: [path.join(pluginDir, "src/promise/index.ts"), path.join(pluginDir, "src/effect/index.ts")],
    root: path.join(pluginDir, "src"),
    outdir: distDir,
    format: "esm",
    target: "bun",
    external: ["effect", "effect/*"],
    splitting: true,
  })

  if (!bundled.success) {
    for (const log of bundled.logs) console.error(log)
    process.exit(1)
  }

  const schemaTsconfig = path.join(tmpConfigs, "tsconfig.schema.json")
  fs.writeFileSync(
    schemaTsconfig,
    JSON.stringify(
      {
        extends: path.join(repoRoot, "tools/tsconfig/base.json"),
        compilerOptions: {
          noEmit: false,
          emitDeclarationOnly: true,
          declaration: true,
          declarationMap: false,
          rootDir: path.join(schemaDir, "src"),
          outDir: schemaOutDir,
          types: [],
          customConditions: [],
        },
        include: [path.join(schemaDir, "src/**/*.ts")],
      },
      null,
      2,
    ),
  )
  run([tscBin, "-p", schemaTsconfig], repoRoot)

  const pluginTsconfig = path.join(tmpConfigs, "tsconfig.plugin.json")
  fs.writeFileSync(
    pluginTsconfig,
    JSON.stringify(
      {
        extends: path.join(repoRoot, "tools/tsconfig/base.json"),
        compilerOptions: {
          noEmit: false,
          emitDeclarationOnly: true,
          declaration: true,
          declarationMap: false,
          rootDir: path.join(pluginDir, "src"),
          outDir: distDir,
          types: [],
          customConditions: [],
        },
        include: [path.join(pluginDir, "src/**/*.ts")],
        exclude: [
          path.join(pluginDir, "src/host.ts"),
          path.join(pluginDir, "src/testing.ts"),
          path.join(pluginDir, "src/effect/launch.ts"),
          path.join(pluginDir, "src/effect/capture.ts"),
          path.join(pluginDir, "src/effect/reconnect.ts"),
          path.join(pluginDir, "src/limits.ts"),
          path.join(pluginDir, "src/promise/adapter.ts"),
        ],
      },
      null,
      2,
    ),
  )
  run([tscBin, "-p", pluginTsconfig], repoRoot)

  if (fs.existsSync(path.join(distDir, "effect/launch.d.ts"))) {
    console.error("@vibest/plugin pack: internal dist/effect/launch.d.ts must not be emitted")
    process.exit(1)
  }

  const emitted = collectFiles(distDir)

  for (const file of emitted) {
    if (file.endsWith(".d.ts")) rewriteSchemaImports(file, schemaOutDir)
  }

  for (const file of emitted) {
    const content = fs.readFileSync(file, "utf8")

    if (content.includes("@vibest/schema")) {
      console.error(`@vibest/plugin pack: leftover @vibest/schema reference in ${path.relative(pluginDir, file)}`)
      process.exit(1)
    }
  }

  const pkgPath = path.join(pluginDir, "package.json")
  const original = fs.readFileSync(pkgPath, "utf8")
  const { "@vibest/schema": _, ...remainingDeps } = pkg.dependencies

  const packed = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    repository: pkg.repository,
    files: ["dist", "README.md", "LICENSE"],
    type: pkg.type,
    exports: {
      ".": { types: "./dist/promise/index.d.ts", import: "./dist/promise/index.js" },
      "./effect": { types: "./dist/effect/index.d.ts", import: "./dist/effect/index.js" },
      "./effect/launch": null,
      "./host": null,
      "./promise/adapter": null,
      "./testing": null,
    },
    publishConfig: pkg.publishConfig,
    ...(Object.keys(remainingDeps).length > 0 ? { dependencies: remainingDeps } : undefined),
    peerDependencies: pkg.peerDependencies,
  }

  fs.writeFileSync(pkgPath, `${JSON.stringify(packed, null, 2)}\n`)

  try {
    run(["pnpm", "pack", "--pack-destination", packsDir], pluginDir)
  } finally {
    fs.writeFileSync(pkgPath, original)
  }
} finally {
  fs.rmSync(tmpConfigs, { recursive: true, force: true })
}
