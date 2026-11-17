import type { ProvidedCommand } from "./runtime.ts"
import type { Spec } from "./spec.ts"

export const withErasedInput = (command: Spec.Any["spec"]) => command as ProvidedCommand
