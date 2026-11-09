import path from "node:path"
import url from "node:url"

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))
process.chdir(root)
const mods = { "vibest-sessions": "src/sessions/main.ts" }

for (const [name, entry] of Object.entries(mods)) {
  const result = await Bun.build({
    entrypoints: [path.join(root, entry)],
    outdir: path.join(root, "home/mods", name),
    naming: "main.js",
    format: "esm",
    target: "browser",
    external: ["gpui-kit", "gpui-base", "herdr"],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
}
