// What a plugin does as a session (`context.session`): vibestd's own Send and Spawn handlers, run with that session
// as the caller, so a plugin may do exactly what the session itself may. The server installs them once its handlers
// exist; until then (and in a host without a server) every action is refused.
import type { SessionActions } from "@vibest/plugin"
import { ActionRefused } from "@vibest/plugin"
import { Context, Effect, Layer } from "effect"

export interface ActionsShape extends SessionActions {
  /** The server's handlers; replaces any earlier ones. */
  readonly install: (actions: SessionActions) => Effect.Effect<void>
}

export class Actions extends Context.Service<Actions, ActionsShape>()("vibest/Actions") {
  static readonly make = (): ActionsShape => {
    let installed: SessionActions | undefined
    const none = Effect.fail(new ActionRefused({ reason: "this vibestd serves no actions yet" }))
    return {
      send: (input) => (installed ? installed.send(input) : none),
      spawn: (input) => (installed ? installed.spawn(input) : none),
      install: (actions) => Effect.sync(() => void (installed = actions)),
    }
  }

  static readonly layer = Layer.sync(Actions, () => Actions.make())
}
