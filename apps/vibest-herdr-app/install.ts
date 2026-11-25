import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { type Keys, mergeKeys } from "./src/shared/merge-keys.ts"

const home = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app")
const dist = path.join(import.meta.dir, "dist")

const readKeys = async (file: string): Promise<Keys | null> =>
  JSON.parse(await fs.readFile(file, "utf8").catch(() => "null"))

const shipped = await readKeys(path.join(import.meta.dir, "src", "keys.json"))
const userFile = path.join(home, "keys.json")
const mine = await readKeys(userFile)

await fs.cp(dist, home, { recursive: true })

console.log(`installed ${dist} into ${home}`)

if (shipped === null || mine === null) {
  console.log(`no ${userFile} yet: open herdr-app once, then run this again to add vibest's keys`)
} else {
  const { keys, kept } = mergeKeys(mine, shipped)

  if (JSON.stringify(keys) !== JSON.stringify(mine)) await fs.writeFile(userFile, `${JSON.stringify(keys, null, 2)}\n`)

  for (const key of kept) console.log(`kept your own binding for ${key}; vibest's is in src/keys.json`)
}
