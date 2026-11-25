import fs from "node:fs"
import path from "node:path"

export const writeAtomicFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content, "utf8")
  fs.renameSync(tmp, filePath)
}
