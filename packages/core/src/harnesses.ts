// The harnesses vibest ships, provided as `Harnesses` by the composition root (and by tests).
import { Harnesses } from "./harness.ts"
import { claude } from "./harnesses/claude.ts"
import { cursor } from "./harnesses/cursor.ts"
import { pi } from "./harnesses/pi.ts"

/** The built-in harnesses, in the order `vibest` lists them. */
export const BUILTIN = { pi, claude, cursor }

export const layer = Harnesses.layer(Object.values(BUILTIN))
