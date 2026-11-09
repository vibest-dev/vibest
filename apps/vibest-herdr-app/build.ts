import fs from "node:fs/promises"
import path from "node:path"

const root = import.meta.dir
const src = path.join(root, "src")
const dist = path.join(root, "dist")

await fs.rm(dist, { recursive: true, force: true })
await fs.cp(path.join(src, "layouts"), path.join(dist, "layouts"), { recursive: true })
await fs.cp(path.join(src, "themes"), path.join(dist, "themes"), { recursive: true })

for await (const entry of new Bun.Glob("mods/*/index.ts").scan(src)) {
  const mod = path.dirname(entry)
  const result = await Bun.build({
    entrypoints: [path.join(src, entry)],
    outdir: path.join(dist, mod),
    naming: "main.js",
    format: "esm",
    target: "browser",
    external: ["gpui-kit", "gpui-base", "herdr"],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  for (const file of ["mod.json", ...new Bun.Glob("*.svg").scanSync(path.join(src, mod))]) {
    await fs.copyFile(path.join(src, mod, file), path.join(dist, mod, file))
  }
}
