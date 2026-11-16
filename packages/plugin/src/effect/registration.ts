import type { Effect, Scope } from "effect"

export interface Registration {
  readonly dispose: Effect.Effect<void>
}

export type Hooks<Spec, Failures extends Record<keyof Spec, unknown> = Record<keyof Spec, never>> = <
  Name extends keyof Spec,
>(
  name: Name,
  callback: (event: Spec[Name]) => Effect.Effect<void, Failures[Name]>,
) => Effect.Effect<Registration, never, Scope.Scope>

export type Transform<Editor> = (callback: (editor: Editor) => void) => Effect.Effect<Registration, never, Scope.Scope>
