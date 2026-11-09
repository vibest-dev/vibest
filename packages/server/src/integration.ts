import { Effect } from "effect"

export const integrationHandlers = Effect.succeed({
  "Harnesses.List": () => Effect.die("P4"),
  "Integration.Guard": () => Effect.die("P4"),
})
