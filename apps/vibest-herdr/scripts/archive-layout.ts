// What the release archive holds besides the compiled binary: harness plugins and the herdr plugin directory.
import fs from "node:fs"
import path from "node:path"

export const ARCHIVE_ROOTS = ["bin", "harnesses", "herdr-plugin"] as const

/** Copy the herdr plugin next to `harnesses/` in a release stage. The directory is linked by the user, never here. */
export const copyHerdrPlugin = (stage: string, source: string) => {
  fs.cpSync(source, path.join(stage, "herdr-plugin"), { recursive: true })
}
