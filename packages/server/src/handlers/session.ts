import { withHeaders } from "@vibest/client/client"
import { attachPlace, filterCallerEnv, specHits } from "@vibest/core/caller"
import { Db } from "@vibest/core/database/db"
import { dedupePairs, expandEdgeSpec, SESSION_PREFIX } from "@vibest/core/database/session-edges"
import { Identity } from "@vibest/core/identity"
import { Runtimes } from "@vibest/core/runtimes"
import { defaultSessionName, NoSuchSession, Session } from "@vibest/core/session"
import { SessionLaunch } from "@vibest/core/session/entry"
import { resolveLiveTarget } from "@vibest/core/session/spawn"
import { Starts } from "@vibest/core/session/starts"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden, InvalidCaller } from "@vibest/protocol/errors"
import { Caller, type CallerIdentity } from "@vibest/protocol/middleware"
import { remoteHeaders } from "@vibest/protocol/protocol"
import type { EdgeSpec } from "@vibest/protocol/schemas"
import type { AgentFrom, AgentSender } from "@vibest/schema/event"
import {
  MachineFailed,
  type MachineIncompatible,
  type MachineUnavailable,
  UnknownMachine,
} from "@vibest/schema/machine"
import { NoSuchProject } from "@vibest/schema/project"
import { AmbiguousSession, LaunchFailed, NoCallingSession, RuntimeUnreachable } from "@vibest/schema/session"
import type { SessionRef } from "@vibest/schema/terminal"
import { Effect, Predicate } from "effect"
import { HttpApiBuilder } from "effect/http-api"

import * as Listing from "../listing.ts"
import { Machines } from "../machine/machines.ts"
import { ListScope, Remote } from "../machine/remote.ts"
import * as CallerChecks from "./caller.ts"
import type { MethodOf } from "./caller.ts"
import { byOf, Routing } from "./remote.ts"

const DEFAULT_AGENT = "coordinator"

const rootAgent = (id: string, named: boolean | undefined) => ({ id, named: named === true })

type ResolvedEndpoint =
  | { readonly local: true; readonly id: string; readonly remoteId: string }
  | { readonly local: false; readonly machine: string; readonly id: string; readonly remoteId: string }

const endpointKey = (ep: ResolvedEndpoint) => (ep.local ? ep.id : `${ep.machine}\0${ep.id}`)

const endpointRef = (ep: ResolvedEndpoint): SessionRef =>
  ep.local ? { id: ep.id } : { id: ep.id, machine: ep.machine }

export const SessionHandler = HttpApiBuilder.group(VibestApi, "server.session", (handlers) =>
  Effect.gen(function* () {
    const { projectOf, scope, machineFromCaller, cliOnly, userOnly, resolveAt, findAt } = yield* CallerChecks.Service
    const { reach, routed, spawnOn } = yield* Routing
    const listing = yield* Listing.Service
    const sessions = yield* Session.Service
    const sessionLaunch = yield* SessionLaunch.Service
    const db = yield* Db.Service
    const selfIdentity = yield* Identity.Service
    const machines = yield* Machines.Service
    const runtimes = yield* Runtimes.Service
    const remoteService = yield* Remote.Service
    const starts = yield* Starts.Service

    const remoteSender = (caller: Extract<CallerIdentity, { readonly _tag: "Remote" }>, from: AgentFrom | undefined) =>
      Effect.gen(function* () {
        if (caller.session === undefined && from === undefined) return undefined

        const machine = yield* db.remote.nameForRemote(caller.remoteId)

        const record: AgentFrom =
          caller.session !== undefined ? (from?.session === caller.session ? from : { session: caller.session }) : from!

        const senderMachine = record.machine ?? machine

        return {
          type: "agent",
          ...(senderMachine !== undefined && { machine: senderMachine }),
          ...record,
        } satisfies AgentSender
      })

    const startedByRemote = (
      scope: NonNullable<Parameters<typeof db.session.resolveSession>[1]>,
      id: string,
      direct: boolean,
    ) =>
      Effect.gen(function* () {
        if (scope.session === undefined) return true
        const route = direct ? yield* db.session.creatorOf(id) : yield* db.session.nearestAlive(id)

        return (
          route !== undefined && "remote" in route && route.remote === scope.remote && route.session === scope.session
        )
      })

    const managed = (method: MethodOf<"owner">, input: string) =>
      Effect.gen(function* () {
        const { c, scope } = yield* reach(method)
        const id = yield* db.session.resolveSession(input, scope)

        if (c === undefined) {
          if (scope !== undefined && !(yield* startedByRemote(scope, id, false)))
            return yield* new Forbidden({
              method,
              message: `${id} was not started by the session that called; a session manages only the sessions it started`,
            })

          return id
        }

        const session = yield* db.session.getSession(id)

        if (!session) return yield* new NoSuchSession({ id, message: `no session ${id}` })

        const manager = yield* db.session.nearestAlive(id)

        if (
          Predicate.isTagged(c, "Session") &&
          (manager === undefined || !("local" in manager) || manager.local !== c.sessionId)
        )
          return yield* new Forbidden({
            method,
            message: `${id} was not started by this session; a session manages only the sessions it started`,
          })

        return id
      })

    const listScope = (all: boolean | undefined) =>
      Effect.gen(function* () {
        const { c, scope } = yield* reach("session.list")

        if (c === undefined) return ListScope.Remote(scope)

        if (Predicate.isTagged(c, "Session")) return ListScope.Project({ id: c.projectId })

        if (Predicate.isTagged(c, "Ui") || all === true) return ListScope.All()

        return yield* findAt(c.repositoryRoot).pipe(
          Effect.map((row): ListScope => (row === undefined ? ListScope.Nothing() : ListScope.Project({ id: row.id }))),
          Effect.catchTag("NotInRepository", () => Effect.succeed(ListScope.All())),
        )
      })

    const linkProject = (method: "session.link" | "session.unlink", spec: EdgeSpec) =>
      Effect.gen(function* () {
        const c = yield* Caller

        if (Predicate.isTagged(c, "Ui")) {
          const refs = Predicate.isTagged(spec, "Directed") ? [...spec.from, ...spec.to] : spec.ids

          if (refs.length === 0)
            return yield* new Forbidden({ method, message: `${method} needs at least one session` })
          const candidates = refs.filter((r) => r.machine === undefined)

          for (const candidate of candidates) {
            const resolved = yield* db.session
              .resolveSession(candidate.id)
              .pipe(Effect.catchTag("NoSuchSession", () => Effect.succeed(undefined)))

            if (resolved !== undefined) {
              const identity = yield* db.session.sessionIdentity(resolved)

              if (identity !== undefined) return identity.projectId
            }
          }

          const first = candidates[0] ?? refs[0]!

          return yield* new NoSuchSession({ id: first.id, message: `no session ${first.id}` })
        }

        const project = yield* scope(method).pipe(
          Effect.catchTag("NotInRepository", (e) => Effect.fail(new Forbidden({ method, message: e.message }))),
        )

        return project.id
      })

    const remoteLiveMatches = (machineName: string, remoteId: string, projectId: string, prefix: string) =>
      remoteService
        .liveSessions(machineName, projectId)
        .pipe(
          Effect.map((rows) =>
            rows
              .filter((s) => s.id.startsWith(prefix))
              .map((s): ResolvedEndpoint => ({ local: false, machine: machineName, id: s.id, remoteId })),
          ),
        )

    const resolveEndpoint = (
      method: string,
      projectId: string,
      ref: SessionRef,
    ): Effect.Effect<
      ResolvedEndpoint,
      Forbidden | NoSuchSession | AmbiguousSession | UnknownMachine | MachineUnavailable | MachineIncompatible
    > =>
      Effect.gen(function* () {
        if (ref.machine === undefined) {
          const resolveLocal = resolveLiveTarget(
            db,
            projectId,
          )(ref.id).pipe(
            Effect.map((id): ResolvedEndpoint => ({ local: true, id, remoteId: selfIdentity.id })),
            Effect.catchTag("LinkRefused", (e) => Effect.fail(new Forbidden({ method, message: e.message }))),
          )

          const machineRows = yield* db.remote.machines

          if (machineRows.length === 0 || !SESSION_PREFIX.test(ref.id)) return yield* resolveLocal

          const remoteHits = (yield* Effect.forEach(
            machineRows,
            (m) =>
              remoteLiveMatches(m.name, m.remoteId, projectId, ref.id).pipe(
                Effect.orElseSucceed((): ReadonlyArray<ResolvedEndpoint> => []),
              ),
            { concurrency: "unbounded" },
          )).flat()

          if (remoteHits.length === 0) return yield* resolveLocal

          const localLookup = yield* Effect.result(db.session.resolveSession(ref.id))

          if (Predicate.isTagged(localLookup, "Success"))
            return yield* new AmbiguousSession({
              prefix: ref.id,
              matches: [localLookup.success, ...remoteHits.map((h) => h.id)],
            })

          if (Predicate.isTagged(localLookup.failure, "AmbiguousSession"))
            return yield* new AmbiguousSession({
              prefix: ref.id,
              matches: [...localLookup.failure.matches, ...remoteHits.map((h) => h.id)],
            })

          if (remoteHits.length > 1)
            return yield* new AmbiguousSession({
              prefix: ref.id,
              matches: remoteHits.map((h) => h.id),
            })

          return remoteHits[0]!
        }

        if (!SESSION_PREFIX.test(ref.id))
          return yield* new NoSuchSession({ id: ref.id, message: `no session ${ref.id} on ${ref.machine}` })
        const machineRow = yield* db.remote.machineNamed(ref.machine)

        if (machineRow === undefined)
          return yield* new UnknownMachine({
            machine: ref.machine,
            machines: (yield* db.remote.machines).map((m) => m.name),
          })

        const matches = yield* remoteLiveMatches(ref.machine, machineRow.remoteId, projectId, ref.id)

        if (matches.length === 0)
          return yield* new NoSuchSession({ id: ref.id, message: `no session ${ref.id} on ${ref.machine}` })

        if (matches.length > 1)
          return yield* new AmbiguousSession({
            prefix: ref.id,
            matches: matches.map((s) => s.id),
          })

        return matches[0]!
      })

    const applyEndpointPairs = (
      pairs: ReadonlyArray<readonly [ResolvedEndpoint, ResolvedEndpoint]>,
      mode: "link" | "unlink",
    ) =>
      Effect.gen(function* () {
        const localEdges: Array<{ readonly from: string; readonly to: string; readonly remote?: string | undefined }> =
          []

        const remoteByMachine = new Map<
          string,
          Array<{ readonly from: string; readonly to: string; readonly remote?: string | undefined }>
        >()

        for (const [from, to] of pairs) {
          if (from.local) {
            localEdges.push(to.local ? { from: from.id, to: to.id } : { from: from.id, to: to.id, remote: to.remoteId })
            continue
          }

          const list = remoteByMachine.get(from.machine) ?? []
          const sameRemote = !to.local && to.machine === from.machine
          list.push(sameRemote ? { from: from.id, to: to.id } : { from: from.id, to: to.id, remote: to.remoteId })
          remoteByMachine.set(from.machine, list)
        }

        if (localEdges.length > 0)
          yield* mode === "link" ? db.session.linkSessions(localEdges) : db.session.unlinkSessions(localEdges)

        for (const [machine, edges] of remoteByMachine)
          yield* mode === "link" ? remoteService.link(machine, edges) : remoteService.unlink(machine, edges)

        return { edges: pairs.map(([from, to]) => ({ from: endpointRef(from), to: endpointRef(to) })) }
      })

    const applyCrossMachineEdges = (
      method: "session.link" | "session.unlink",
      projectId: string,
      spec: EdgeSpec,
      mode: "link" | "unlink",
    ) =>
      expandEdgeSpec(
        spec,
        (ref) => resolveEndpoint(method, projectId, ref),
        endpointKey,
        (message) => Effect.fail(new Forbidden({ method, message })),
      ).pipe(Effect.flatMap((pairs) => applyEndpointPairs(pairs, mode)))

    const linkSpawnedEndpoints = (
      spawnedEp: ResolvedEndpoint,
      fromEndpoints: ReadonlyArray<ResolvedEndpoint>,
      toEndpoints: ReadonlyArray<ResolvedEndpoint>,
      withEndpoints: ReadonlyArray<ResolvedEndpoint>,
    ) => {
      const pairs = dedupePairs(
        [
          ...fromEndpoints.map((from): readonly [ResolvedEndpoint, ResolvedEndpoint] => [from, spawnedEp]),
          ...toEndpoints.map((to): readonly [ResolvedEndpoint, ResolvedEndpoint] => [spawnedEp, to]),
          ...withEndpoints.flatMap((target): ReadonlyArray<readonly [ResolvedEndpoint, ResolvedEndpoint]> => [
            [target, spawnedEp],
            [spawnedEp, target],
          ]),
        ],
        endpointKey,
      )

      return pairs.length > 0 ? applyEndpointPairs(pairs, "link") : Effect.void
    }

    return handlers
      .handle("session.list", ({ query: { stopped, all } }) =>
        Effect.gen(function* () {
          const scope = yield* listScope(all)
          const local = yield* listing.listed(scope, stopped === true)
          const away = yield* remoteService.list(scope, byOf(yield* Caller), stopped)

          return { sessions: [...local, ...away.sessions], machines: away.machines }
        }),
      )
      .handle("session.get", ({ params: { id }, query: { machine } }) =>
        routed.get({ id, ...(machine !== undefined && { machine }) }, (input) =>
          Effect.gen(function* () {
            const resolved = yield* db.session.resolveSession(input, (yield* reach("session.get")).scope)
            const row = yield* sessions.get(resolved)

            const session = Listing.toInfo(
              row,
              (yield* db.session.sessionBriefs([resolved])).get(resolved),
              (yield* starts.choices).get(resolved),
            )

            return {
              ...session,
              reply: (yield* db.session.latestReply(resolved)) ?? null,
            }
          }),
        ),
      )
      .handle("session.peek", ({ params: { id }, query: { machine, lines } }) =>
        routed.peek({ id, ...(machine !== undefined && { machine }), ...(lines !== undefined && { lines }) }, (input) =>
          managed("session.peek", input).pipe(
            Effect.flatMap((resolved) => sessions.peek(resolved, lines ?? 30)),
            Effect.map((text) => ({ text })),
          ),
        ),
      )
      .handle("session.spawn", ({ payload: input }) =>
        Effect.gen(function* () {
          const c = yield* Caller

          if (!Predicate.isTagged(c, "Session")) return yield* new NoCallingSession()
          const project = yield* projectOf(c, "session.spawn")

          if (input.machine !== undefined) {
            const resolve = (ref: SessionRef) => resolveEndpoint("session.spawn", project.id, ref)
            const fromEndpoints = yield* Effect.forEach(input.from ?? [], resolve)
            const toEndpoints = yield* Effect.forEach(input.to ?? [], resolve)
            const withEndpoints = yield* Effect.forEach(input.with ?? [], resolve)
            const spawned = yield* spawnOn(input.machine, input, c.sessionId, project.id)

            if (fromEndpoints.length > 0 || toEndpoints.length > 0 || withEndpoints.length > 0) {
              const machineRow = (yield* db.remote.machineNamed(input.machine))!

              yield* linkSpawnedEndpoints(
                { local: false, machine: input.machine, id: spawned.id, remoteId: machineRow.remoteId },
                fromEndpoints,
                toEndpoints,
                withEndpoints,
              )
            }

            return spawned
          }

          if (input.project !== undefined)
            return yield* new MachineFailed({
              message: "--project names a project of another machine; give --machine too",
            })

          const resolve = (ref: SessionRef) => resolveEndpoint("session.spawn", project.id, ref)
          const fromEndpoints = yield* Effect.forEach(input.from ?? [], resolve)
          const toEndpoints = yield* Effect.forEach(input.to ?? [], resolve)
          const withEndpoints = yield* Effect.forEach(input.with ?? [], resolve)
          const allEndpoints = [...fromEndpoints, ...toEndpoints, ...withEndpoints]
          const anyRemoteLink = allEndpoints.some((ep) => !ep.local)

          const spawned = yield* sessions
            .spawn({
              machine: yield* machineFromCaller("session.spawn", input),
              root: project.directory,
              projectId: project.id,
              name: input.name ?? defaultSessionName(input.prompt),
              prompt: input.prompt,
              harness: input.harness,
              provider: input.provider,
              model: input.model,
              env: input.env,
              agent: input.agent,
              share: input.share === undefined ? undefined : yield* db.session.resolveSession(input.share),
              runtime: input.runtime,
              parentSessionId: c.sessionId,
              request: input.request,
              files: input.files,
              ...(allEndpoints.length > 0 &&
                !anyRemoteLink && {
                  from: fromEndpoints.map((ep) => ep.id),
                  to: toEndpoints.map((ep) => ep.id),
                  with: withEndpoints.map((ep) => ep.id),
                }),
            })
            .pipe(
              Effect.catchTag("LinkRefused", (e) =>
                Effect.fail(new Forbidden({ method: "session.spawn", message: e.message })),
              ),
            )

          if (anyRemoteLink)
            yield* linkSpawnedEndpoints(
              { local: true, id: spawned.id, remoteId: selfIdentity.id },
              fromEndpoints,
              toEndpoints,
              withEndpoints,
            )

          return spawned
        }),
      )
      .handle("session.launch", ({ payload: input }) =>
        Effect.gen(function* () {
          const caller = yield* Caller
          const away = input.machine !== undefined

          if (away) {
            if (Predicate.isTagged(caller, "Remote"))
              return yield* new Forbidden({
                method: "session.launch",
                message: "a remote launches only on this machine",
              })
            const link = yield* machines.link(input.machine!)
            const { machine: _, ...forwarded } = input

            return yield* link.call(
              withHeaders(
                link.client["server.session"]["session.launch"]({ payload: forwarded }),
                remoteHeaders(selfIdentity.id),
              ),
            )
          }

          if (!Predicate.isTagged(caller, "Remote")) yield* userOnly("session.launch")

          const project = yield* Effect.gen(function* () {
            if (input.projectId !== undefined) {
              const directory = yield* db.project.projectDirectory(input.projectId)

              if (directory === undefined) return yield* new NoSuchProject({ project: input.projectId })

              return { id: input.projectId, directory }
            }

            if (Predicate.isTagged(caller, "Cli")) return yield* resolveAt(caller.repositoryRoot)

            return yield* new InvalidCaller({ method: "session.launch", message: "session.launch needs projectId" })
          })

          const at =
            input.callerEnv !== undefined || input.runtimeSession !== undefined
              ? yield* machineFromCaller("session.launch", {
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
                method: "session.launch",
                message: `session ${e.sessionId} (${e.harness}) is still running in ${e.place}; exit it there first or pass --new`,
              }),
            ),
          ),
        ),
      )
      .handle("session.attach", ({ payload: { callerEnv, runtime, sessionId, fresh, agent, agentNamed } }) =>
        Effect.gen(function* () {
          const c = yield* cliOnly("session.attach")
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

          if (agent !== undefined || agentNamed === true)
            yield* sessionLaunch.checkAgent(
              project.id,
              sessionId,
              fresh === true,
              rootAgent(agent ?? DEFAULT_AGENT, agentNamed),
            )

          const hasRoot = (yield* db.session.latestRoot(project.id)) !== undefined

          const running =
            fresh === true
              ? null
              : yield* sessionLaunch.running(
                  project.id,
                  place.in === "terminal" ? place.terminal : undefined,
                  sessionId,
                )

          return { projectId: project.id, directory: project.directory, hasRoot, place, running }
        }),
      )
      .handle("session.focus", () =>
        cliOnly("session.focus").pipe(
          Effect.flatMap((c) => resolveAt(c.repositoryRoot)),
          Effect.flatMap((project) => sessionLaunch.focus(project.id)),
        ),
      )
      .handle(
        "session.claim",
        ({
          payload: { sessionId, harness, agent, agentNamed, fresh, move, terminal, runtime, provider, model, pid },
        }) =>
          Effect.gen(function* () {
            const { id, directory } = yield* cliOnly("session.claim").pipe(
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
                  method: "session.claim",
                  message: `session ${e.sessionId} (${e.harness}) is still running in ${e.place}; move it here or start a new conversation with --new`,
                }),
              ),
            ),
          ),
      )
      .handle("session.send", ({ params: { id }, payload: p }) =>
        routed.send({ id, ...p }, (input) =>
          Effect.gen(function* () {
            const caller = yield* Caller

            if (Predicate.isTagged(caller, "Session"))
              return yield* sessions
                .admit(caller, input, p.message, p.request)
                .pipe(
                  Effect.catchTag("SendRefused", (e) =>
                    Effect.fail(new Forbidden({ method: "session.send", message: e.message })),
                  ),
                )
            const { c, scope } = yield* reach("session.send")

            const target = yield* db.session
              .resolveSession(input, scope)
              .pipe(
                Effect.catchTag("NoSuchSession", (err) =>
                  scope !== undefined && scope.session === undefined && p.from !== undefined
                    ? db.session.resolveSession(input)
                    : Effect.fail(err),
                ),
              )

            if (c === undefined && scope !== undefined && !(yield* startedByRemote(scope, target, true)))
              return yield* new Forbidden({
                method: "session.send",
                message: `${target} was not started by the session that called, and it did not start it; a message goes only to the session that started it or to a session it started`,
              })
            const from = Predicate.isTagged(caller, "Remote") ? yield* remoteSender(caller, p.from) : undefined
            yield* sessions.send(target, p.message, from ?? { type: "user" }, p.request)

            return { id: target }
          }),
        ),
      )
      .handle("session.interrupt", ({ params: { id }, query: { machine } }) =>
        routed.interrupt({ id, ...(machine !== undefined && { machine }) }, (input) =>
          managed("session.interrupt", input).pipe(
            Effect.flatMap((resolved) =>
              sessions.interrupt(resolved).pipe(Effect.map((out) => ({ id: resolved, ...out }))),
            ),
          ),
        ),
      )
      .handle("session.stop", ({ params: { id }, query: { machine } }) =>
        routed.stop({ id, ...(machine !== undefined && { machine }) }, (input) =>
          managed("session.stop", input).pipe(
            Effect.flatMap((resolved) =>
              Effect.gen(function* () {
                const caller = yield* Caller

                const fromSession = Predicate.isTagged(caller, "Session")
                  ? yield* db.remote.senderOf(caller.sessionId)
                  : undefined

                const by = Predicate.isTagged(caller, "Remote")
                  ? ((yield* remoteSender(caller, undefined)) ?? { type: "user" as const })
                  : fromSession === undefined
                    ? { type: "user" as const }
                    : { type: "agent" as const, ...fromSession }

                const { message } = yield* sessions.stop(resolved, by)

                return { id: resolved, message }
              }),
            ),
          ),
        ),
      )
      .handle("session.archive", ({ params: { id }, payload: { machine, keepWorktree } }) =>
        routed.archive(
          { id, ...(machine !== undefined && { machine }), ...(keepWorktree !== undefined && { keepWorktree }) },
          (input) =>
            managed("session.archive", input).pipe(
              Effect.flatMap((resolved) =>
                sessions
                  .archive(resolved, { keepWorktree })
                  .pipe(
                    Effect.catchTag("RuntimeError", (e) =>
                      e.code === "unreachable"
                        ? Effect.fail(new RuntimeUnreachable({ session: resolved, message: e.message }))
                        : Effect.die(e),
                    ),
                  ),
              ),
              Effect.map((out) => out ?? null),
            ),
        ),
      )
      .handle("session.link", ({ payload: { spec } }) =>
        linkProject("session.link", spec).pipe(
          Effect.flatMap((projectId) => applyCrossMachineEdges("session.link", projectId, spec, "link")),
        ),
      )
      .handle("session.unlink", ({ payload: { spec } }) =>
        linkProject("session.unlink", spec).pipe(
          Effect.flatMap((projectId) => applyCrossMachineEdges("session.unlink", projectId, spec, "unlink")),
        ),
      )
      .handle("session.seen", ({ params: { id }, payload: { finished } }) =>
        userOnly("session.seen").pipe(Effect.andThen(sessions.seen(id, finished))),
      )
  }),
)
