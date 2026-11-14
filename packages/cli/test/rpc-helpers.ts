import { it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db } from "@vibest/core/database/db"
import { Project } from "@vibest/core/project"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { Layout } from "@vibest/schema/layout"
import * as Server from "@vibest/server/server"
import { Cause, Effect, Exit, Layer, Option, type Scope } from "effect"

import * as Platform from "#platform"

import { authed, projectOf, testLayer, type TestOptions, type TestServices } from "./fakes.ts"

export const served = (options?: TestOptions) =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer(options)),
  )

export const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>,
  options?: TestOptions,
  timeout?: number,
) => it.effect(name, () => program.pipe(Effect.provide(served(options))), timeout)

export const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))
export const asCli = (raw: Effect.Success<typeof client>, repositoryRoot: string) =>
  authed(raw, cliHeaders(repositoryRoot))
export const asSession = (raw: Effect.Success<typeof client>, sessionId: string, repositoryRoot?: string) =>
  Effect.gen(function* () {
    const row = yield* (yield* Db).sessionIdentity(sessionId)
    return authed(raw, sessionHeaders({ sessionId, repositoryRoot, projectId: row && String(row.projectId) }))
  })

export const asEntry = (raw: Effect.Success<typeof client>, repositoryRoot: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const projectId = yield* projectOf(repositoryRoot)
    const entry =
      (yield* db.entryOf(projectId))?.id ??
      (yield* db.startEntry(
        projectId,
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "test/entry" },
        },
        { agent: "coordinator" },
      )).sessionId
    return authed(raw, sessionHeaders({ sessionId: entry, repositoryRoot, projectId }))
  })

export const failureTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? Option.match(Cause.findErrorOption(exit.cause), { onNone: () => "defect", onSome: (e) => e._tag })
    : "success"
