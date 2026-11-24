import { EntrySession } from "@vibest/core/session/entry"
import { Forbidden, InvalidCaller } from "@vibest/protocol/rpc"
import { Effect } from "effect"

import * as CallerChecks from "./caller.ts"
import type { Handlers } from "./caller.ts"
import { group } from "./group.ts"

const entryAgent = (id: string, named: boolean | undefined) => ({ id, named: named === true })

export const make = Effect.gen(function* () {
  const { scope, machineFromCaller, cliOnly, resolveAt } = yield* CallerChecks.Service
  const entrySession = yield* EntrySession.Service

  return {
    Launch: ({ argv, agent, agentNamed, focus, runtime, callerEnv, runtimeSession }) =>
      Effect.gen(function* () {
        const { id, directory } = yield* cliOnly("Launch").pipe(Effect.flatMap((c) => resolveAt(c.repositoryRoot)))
        const at = yield* machineFromCaller("Launch", { callerEnv, runtime, runtimeSession })

        return yield* entrySession.launch({
          projectId: id,
          root: directory,
          at,
          argv,
          focus,
          runtime,
          agent: entryAgent(agent, agentNamed),
        })
      }).pipe(
        Effect.catchTag("EntryRunning", (e) =>
          Effect.fail(
            new Forbidden({
              method: "Launch",
              message: `the entry session (${e.harness}) is still running in ${e.place}, and a project has one entry session; exit it there first`,
            }),
          ),
        ),
      ),

    "Project.StartEntry": ({ harness, agent, agentNamed, fresh, provider, model, runtime }) =>
      Effect.gen(function* () {
        const { id, directory } = yield* cliOnly("Project.StartEntry").pipe(
          Effect.flatMap((c) => resolveAt(c.repositoryRoot)),
        )

        return yield* entrySession.start({
          projectId: id,
          root: directory,
          harness,
          agent: entryAgent(agent, agentNamed),
          fresh: fresh === true,
          provider,
          model,
          runtime,
        })
      }),

    "Project.EntrySession": ({ harness, agent, agentNamed, fresh, terminal, runtime, provider, model, routing, pid }) =>
      Effect.gen(function* () {
        const { id, directory } = yield* cliOnly("Project.EntrySession").pipe(
          Effect.flatMap((c) => resolveAt(c.repositoryRoot)),
        )

        return yield* entrySession.claim({
          projectId: id,
          directory,
          harness,
          agent: entryAgent(agent, agentNamed),
          fresh,
          terminal,
          runtime,
          provider,
          model,
          routing,
          pid,
        })
      }).pipe(
        Effect.catchTags({
          NoRuntime: () =>
            Effect.fail(
              new InvalidCaller({
                method: "Project.EntrySession",
                message: "Project.EntrySession needs the runtime the entry session runs in",
              }),
            ),
          EntryRunning: (e) =>
            Effect.fail(
              new Forbidden({
                method: "Project.EntrySession",
                message: `the entry session (${e.harness}) is still running in ${e.place}, and a project has one entry session; exit it there first, or run vibest here on an interactive terminal and answer y to move it here`,
              }),
            ),
        }),
      ),

    "Project.FocusEntry": () =>
      Effect.gen(function* () {
        const c = yield* cliOnly("Project.FocusEntry")
        const project = yield* resolveAt(c.repositoryRoot)

        return yield* entrySession.focus(project.id)
      }),

    "Project.RunningEntry": ({ terminal }) =>
      scope("Project.RunningEntry").pipe(Effect.flatMap(({ id }) => entrySession.running(id, terminal))),

    "Project.StopEntry": ({ runtime, target }) =>
      Effect.gen(function* () {
        const { id } = yield* cliOnly("Project.StopEntry").pipe(Effect.flatMap((c) => resolveAt(c.repositoryRoot)))

        return yield* entrySession
          .stop(id, runtime, target)
          .pipe(
            Effect.catchTag("NoRuntime", (e) =>
              Effect.fail(new InvalidCaller({ method: "Project.StopEntry", message: e.message })),
            ),
          )
      }),
  } satisfies Handlers
})

export const layer = group([
  "Launch",
  "Project.StartEntry",
  "Project.EntrySession",
  "Project.FocusEntry",
  "Project.RunningEntry",
  "Project.StopEntry",
]).toLayer(make)
