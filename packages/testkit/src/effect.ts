import { it } from "@effect/vitest"
import { Effect, type Layer, type Scope } from "effect"

export const testEffect =
  <R, E>(layer: Layer.Layer<R, E>) =>
  <A, E2, R2>(name: string, program: () => Effect.Effect<A, E2, R2>, timeout?: number) =>
    it.effect(name, () => program().pipe(Effect.provide(layer)) as Effect.Effect<A, E | E2, Scope.Scope>, timeout)
