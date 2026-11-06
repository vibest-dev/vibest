import { Harnesses } from "./harness.ts"
import { claude } from "./harnesses/claude.ts"
import { cursor } from "./harnesses/cursor.ts"
import { pi } from "./harnesses/pi.ts"

export const BUILTIN = { pi, claude, cursor }

export const layer = Harnesses.layer(BUILTIN)
