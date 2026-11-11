import { reapFile } from "./tools/reap.ts"

process.env.VIBEST_REAP_FILE ??= reapFile(process.ppid)
delete process.env.PI_PACKAGE_DIR
