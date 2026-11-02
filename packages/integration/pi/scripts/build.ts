// Write the extension Pi loads with `pi -e <outdir>/extension.mjs`: src/extension.ts and everything it imports in one ES
// module, except Pi's own packages, which Pi resolves for the extensions it loads.
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outdir = path.resolve(process.argv[2] ?? path.join(root, "dist"))
// Bun writes each module's path relative to the working directory into the bundle; pin it so the bytes don't vary.
process.chdir(root)
const result = await Bun.build({
  entrypoints: [path.join(root, "src/extension.ts")],
  outdir,
  naming: "extension.mjs",
  target: "node",
  format: "esm",
  external: ["@earendil-works/*"],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
