import { commandOf, note } from "./reap.ts"

note(process.pid, commandOf(process.pid).trim())
