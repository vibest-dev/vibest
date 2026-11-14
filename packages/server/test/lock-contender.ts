import { daemon } from "@vibest/platform-bun/bun"
import { Effect } from "effect"

const held = await Effect.runPromise(Effect.scoped(daemon.lock(process.argv[2]!)))
console.log(held !== undefined ? "ACQUIRED" : "BUSY")
