import type { Effect, Scope } from "effect"

export interface Registration {
  readonly dispose: Effect.Effect<void>
}

export type Hooks<
  Spec,
  Results extends Record<keyof Spec, unknown>,
  Failures extends Record<keyof Spec, unknown> = Record<keyof Spec, never>,
> = <Name extends keyof Spec>(
  name: Name,
  callback: (event: Spec[Name]) => Effect.Effect<Results[Name] | void, Failures[Name]>,
) => Effect.Effect<Registration, never, Scope.Scope>

export type Transform<Editor> = (callback: (editor: Editor) => void) => Effect.Effect<Registration, never, Scope.Scope>
