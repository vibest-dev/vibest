// Write the plugin's files (src/plugin.ts) into <outdir>, default this package (prepack). Generated and ignored by Git.
import fs from "node:fs"
import path from "node:path"
import url from "node:url"
import { files } from "../src/plugin.ts"

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))
const outdir = path.resolve(process.argv[2] ?? root)
for (const [name, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(outdir, name)), { recursive: true })
  fs.writeFileSync(path.join(outdir, name), text)
}
