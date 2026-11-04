// Another process asking for vibestd's start lock through the real adapter, once: prints ACQUIRED or BUSY, then lets go.
import { Effect } from "effect"

import { daemon } from "#platform"

const held = await Effect.runPromise(Effect.scoped(daemon.lock(process.argv[2]!)))
console.log(held !== undefined ? "ACQUIRED" : "BUSY")
