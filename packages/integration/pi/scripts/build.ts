import path from "node:path"
import url from "node:url"

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))
const outdir = path.resolve(process.argv[2] ?? path.join(root, "dist"))
process.chdir(root)
const result = await Bun.build({
  entrypoints: [path.join(root, "src/extension.ts"), path.join(root, "src/presentation.ts")],
  outdir,
  naming: "[name].mjs",
  target: "node",
  format: "esm",
  external: ["@earendil-works/*"],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
