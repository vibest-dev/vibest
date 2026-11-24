import { attachPlace, filterCallerEnv, specHits } from "@vibest/core/caller"
import { Db } from "@vibest/core/database/db"
import { Identity } from "@vibest/core/identity"
import { Runtimes } from "@vibest/core/runtimes"
import { SessionLaunch } from "@vibest/core/session/entry"
import { remoteHeaders } from "@vibest/protocol/protocol"
import { Caller, Forbidden, InvalidCaller } from "@vibest/protocol/rpc"
import { NoSuchProject } from "@vibest/schema/project"
import { LaunchFailed } from "@vibest/schema/session"
import { Effect, Predicate } from "effect"

import { Machines } from "../machine/machines.ts"
import * as CallerChecks from "./caller.ts"
import type { Handlers } from "./caller.ts"
import { group } from "./group.ts"

const DEFAULT_AGENT = "coordinator"

const rootAgent = (id: string, named: boolean | undefined) => ({ id, named: named === true })

export const make = Effect.gen(function* () {
  const { machineFromCaller, cliOnly, userOnly, resolveAt } = yield* CallerChecks.Service
  const db = yield* Db.Service
  const self = yield* Identity.Service
  const machines = yield* Machines.Service
  const runtimes = yield* Runtimes.Service
  const sessionLaunch = yield* SessionLaunch.Service

  return {
    Launch: (input) =>
      Effect.gen(function* () {
        const caller = yield* Caller
        const away = input.machine !== undefined

        if (away) {
          if (Predicate.isTagged(caller, "Remote"))
            return yield* new Forbidden({ method: "Launch", message: "a remote launches only on this machine" })
          const link = yield* machines.link(input.machine!)
          const { machine: _, ...forwarded } = input

          return yield* link.call(link.client.Launch(forwarded, { headers: remoteHeaders(self.id) }))
        }

        if (!Predicate.isTagged(caller, "Remote")) yield* userOnly("Launch")

        const project = yield* Effect.gen(function* () {
          if (input.projectId !== undefined) {
            const directory = yield* db.project.projectDirectory(input.projectId)

            if (directory === undefined) return yield* new NoSuchProject({ project: input.projectId })

            return { id: input.projectId, directory }
          }

          if (Predicate.isTagged(caller, "Cli")) return yield* resolveAt(caller.repositoryRoot)

          return yield* new InvalidCaller({ method: "Launch", message: "Launch needs projectId" })
        })

        const at =
          input.callerEnv !== undefined || input.runtimeSession !== undefined
            ? yield* machineFromCaller("Launch", {
                callerEnv: input.callerEnv ?? {},
                runtime: input.runtime,
                runtimeSession: input.runtimeSession,
              })
            : { id: "local" }

        return yield* sessionLaunch.launch({
          projectId: project.id,
          root: project.directory,
          at,
          sessionId: input.sessionId,
          fresh: input.fresh === true,
          move: input.move === true,
          harness: input.harness,
          provider: input.provider,
          model: input.model,
          focus: Predicate.isTagged(caller, "Ui") ? false : (input.focus ?? true),
          runtime: input.runtime,
          agent: rootAgent(input.agent ?? DEFAULT_AGENT, input.agentNamed),
        })
      }).pipe(
        Effect.catchTag("SessionRunning", (e) =>
          Effect.fail(
            new Forbidden({
              method: "Launch",
              message: `session ${e.sessionId} (${e.harness}) is still running in ${e.place}; exit it there first or pass --new`,
            }),
          ),
        ),
      ),

    "Session.Attach": ({ callerEnv, runtime, sessionId, fresh }) =>
      Effect.gen(function* () {
        const c = yield* cliOnly("Session.Attach")
        const project = yield* resolveAt(c.repositoryRoot)
        const specs = yield* runtimes.callers
        const env = filterCallerEnv(specs, callerEnv)
        const hits = yield* specHits(specs, env, runtime).pipe(Effect.orDie)
        const place = attachPlace({ runtime, hits, loaded: specs.map((spec) => spec.id) })

        if (place.in === "refused") return yield* new LaunchFailed({ message: place.message })

        if (place.in === "terminal") {
          const spec = specs.find((item) => item.id === place.runtime)

          if (spec?.ready !== undefined && !(yield* spec.ready(env).pipe(Effect.orDie)))
            return yield* new LaunchFailed({
              message: spec.missing ?? `this ${spec.name ?? place.runtime} place could not be named`,
            })
        }

        const hasRoot = (yield* db.session.latestRoot(project.id)) !== undefined

        const running =
          fresh === true
            ? null
            : yield* sessionLaunch.running(project.id, place.in === "terminal" ? place.terminal : undefined, sessionId)

        return { projectId: project.id, directory: project.directory, hasRoot, place, running }
      }),

    "Session.Claim": ({
      sessionId,
      harness,
      agent,
      agentNamed,
      fresh,
      move,
      terminal,
      runtime,
      provider,
      model,
      pid,
    }) =>
      Effect.gen(function* () {
        const { id, directory } = yield* cliOnly("Session.Claim").pipe(
          Effect.flatMap((c) => resolveAt(c.repositoryRoot)),
        )

        return yield* sessionLaunch.claim({
          projectId: id,
          directory,
          sessionId,
          harness,
          agent: rootAgent(agent, agentNamed),
          fresh,
          move: move === true,
          terminal,
          runtime,
          provider,
          model,
          pid,
        })
      }).pipe(
        Effect.catchTag("SessionRunning", (e) =>
          Effect.fail(
            new Forbidden({
              method: "Session.Claim",
              message: `session ${e.sessionId} (${e.harness}) is still running in ${e.place}; move it here or start a new conversation with --new`,
            }),
          ),
        ),
      ),
  } satisfies Handlers
})

export const layer = group(["Launch", "Session.Attach", "Session.Claim"]).toLayer(make)
