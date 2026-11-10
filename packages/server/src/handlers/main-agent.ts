import { MainAgent } from "@vibest/core/main-agent"
import { Forbidden, InvalidCaller } from "@vibest/protocol/rpc"
import { Effect } from "effect"

import type { Checks, Handlers } from "./caller.ts"

export const make = ({ scope, machineFromCaller, cliOnly, resolveAt }: Checks) =>
  Effect.gen(function* () {
    const mainAgent = yield* MainAgent
    return {
      Launch: ({ argv, focus, runtime, callerEnv, runtimeSession }) =>
        Effect.gen(function* () {
          const { id, directory } = yield* scope("Launch")
          const at = yield* machineFromCaller({ callerEnv, runtimeSession })
          return yield* mainAgent.launch({ projectId: id, root: directory, at, argv, focus, runtime })
        }).pipe(
          Effect.catchTag("MainAgentRunning", (e) =>
            Effect.fail(
              new Forbidden({
                method: "Launch",
                message: `the main agent (${e.harness}) is still running in ${e.place}, and a project has one main agent; exit it there first`,
              }),
            ),
          ),
        ),

      "Project.StartMain": ({ harness, provider, model, runtime }) =>
        Effect.gen(function* () {
          const { id, directory } = yield* scope("Project.StartMain")
          return yield* mainAgent.start({ projectId: id, root: directory, harness, provider, model, runtime })
        }),

      "Project.CoordinatorSession": ({ harness, fresh, terminal, runtime, provider, model, routing, pid }) =>
        Effect.gen(function* () {
          const { id, directory } = yield* scope("Project.CoordinatorSession")
          return yield* mainAgent.claim({
            projectId: id,
            directory,
            harness,
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
                  method: "Project.CoordinatorSession",
                  message: "Project.CoordinatorSession needs the runtime the main agent runs in",
                }),
              ),
            MainAgentRunning: (e) =>
              Effect.fail(
                new Forbidden({
                  method: "Project.CoordinatorSession",
                  message: `the main agent (${e.harness}) is still running in ${e.place}, and a project has one main agent; exit it there first, or run vibest here on an interactive terminal and answer y to move it here`,
                }),
              ),
          }),
        ),

      "Project.FocusCoordinator": () =>
        Effect.gen(function* () {
          const c = yield* cliOnly("Project.FocusCoordinator")
          const project = yield* resolveAt(c.repositoryRoot)
          return yield* mainAgent.focus(project.id)
        }),

      "Project.RunningCoordinator": ({ terminal }) =>
        scope("Project.RunningCoordinator").pipe(Effect.flatMap(({ id }) => mainAgent.running(id, terminal))),

      "Project.StopCoordinator": ({ runtime, address }) =>
        Effect.gen(function* () {
          const { id } = yield* scope("Project.StopCoordinator")
          return yield* mainAgent
            .stop(id, runtime, address)
            .pipe(
              Effect.catchTag("NoRuntime", (e) =>
                Effect.fail(new InvalidCaller({ method: "Project.StopCoordinator", message: e.message })),
              ),
            )
        }),

      CoordinatorSessionReady: ({ sessionId, harness, harnessSessionId }) =>
        mainAgent.ready(sessionId, harness, harnessSessionId),
    } satisfies Handlers
  })
