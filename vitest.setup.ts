import path from "node:path"

import { reapFile } from "./tools/reap.ts"

process.env.VIBEST_REAP_FILE ??= reapFile(process.ppid)
const preloadEveryBunChild = `--preload ${path.join(import.meta.dirname, "tools/reap-preload.ts")}`
if (!process.env.BUN_OPTIONS?.includes(preloadEveryBunChild))
  process.env.BUN_OPTIONS = [process.env.BUN_OPTIONS, preloadEveryBunChild].filter(Boolean).join(" ")
delete process.env.PI_PACKAGE_DIR
