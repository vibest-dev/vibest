import path from "node:path"
import url from "node:url"

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))
process.chdir(root)
const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: "home/mods/vibest",
  naming: "main.js",
  format: "esm",
  target: "browser",
  external: ["gpui-kit", "gpui-base", "herdr"],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
