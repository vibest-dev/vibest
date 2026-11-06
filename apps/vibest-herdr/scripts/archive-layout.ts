import fs from "node:fs"
import path from "node:path"

export const ARCHIVE_ROOTS = ["bin", "harnesses", "herdr-plugin"] as const

export const copyHerdrPlugin = (stage: string, source: string) => {
  fs.cpSync(source, path.join(stage, "herdr-plugin"), { recursive: true })
}
