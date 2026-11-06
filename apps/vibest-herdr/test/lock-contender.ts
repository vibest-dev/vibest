import { Effect } from "effect"

import { daemon } from "../src/platform/bun.ts"

const held = await Effect.runPromise(Effect.scoped(daemon.lock(process.argv[2]!)))
console.log(held !== undefined ? "ACQUIRED" : "BUSY")
