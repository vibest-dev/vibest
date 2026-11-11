import fs from "node:fs"

import { endNoted, reapEndedRuns, reapFile, startWatch, survivors } from "./tools/reap.ts"

export default async function setup() {
  await reapEndedRuns()
  const file = reapFile()
  fs.writeFileSync(file, "")
  process.env.VIBEST_REAP_FILE = file
  startWatch(process.pid, file)
  return async () => {
    const left = survivors(file)
    await endNoted(file)
    fs.rmSync(file, { force: true })
    if (left.length > 0) throw new Error(`processes still alive after the tests: ${left.join("; ")}`)
  }
}
