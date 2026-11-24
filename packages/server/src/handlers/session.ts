import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { terminalOf } from "@vibest/core/database/db-rows"
import { expandEdgeSpec, SESSION_PREFIX } from "@vibest/core/database/session-edges"
import { KeyedMutex } from "@vibest/core/effect/keyed-mutex"
import { Identity } from "@vibest/core/identity"
import { Integration } from "@vibest/core/integration"
import { raisesSeen } from "@vibest/core/project/activity"
import { Runtimes } from "@vibest/core/runtimes"
import { defaultSessionName, NoSuchSession, Session } from "@vibest/core/session"
import { resolveLiveTarget } from "@vibest/core/session/spawn"
import { Starts } from "@vibest/core/session/starts"
import { Caller, type CallerIdentity, type EdgeSpec, Forbidden, type WatchEvent } from "@vibest/protocol/rpc"
import type { AgentFrom, AgentSender } from "@vibest/schema/event"
import { MachineFailed, UnknownMachine } from "@vibest/schema/machine"
import { AmbiguousSession, NoCallingSession, RuntimeUnreachable } from "@vibest/schema/session"
import { canonicalTarget, formatSessionRef, type SessionRef } from "@vibest/schema/terminal"
import { Effect, Predicate, Stream } from "effect"

import { integrationOf, processOf, reader } from "../gates.ts"
import * as Listing from "../listing.ts"
import { RemoteWatch } from "../machine/remote-watch.ts"
import { ListScope, Remote } from "../machine/remote.ts"
import { WatchFeed } from "../watch-feed.ts"
import * as CallerChecks from "./caller.ts"
import type { Handlers, MethodOf } from "./caller.ts"
import { group } from "./group.ts"
import { Routing } from "./remote.ts"

type ResolvedEndpoint =
  | { readonly local: true; readonly id: string; readonly remoteId: string }
  | { readonly local: false; readonly machine: string; readonly id: string; readonly remoteId: string }

const endpointKey = (ep: ResolvedEndpoint) => (ep.local ? ep.id : `${ep.machine}/${ep.id}`)

const endpointRef = (ep: ResolvedEndpoint): SessionRef =>
  ep.local ? { id: ep.id } : { id: ep.id, machine: ep.machine }

export const make = Effect.gen(function* () {
  const { projectOf, scope, machineFromCaller, cliOnly, userOnly, self: selfCaller } = yield* CallerChecks.Service
  const { reach, routed, spawnOn } = yield* Routing
  const { listed, watched, snapshotProjects } = yield* Listing.Service
  const sessions = yield* Session.Service
  const db = yield* Db.Service
  const selfIdentity = yield* Identity.Service
  const runtimes = yield* Runtimes.Service
  const watchFeed = yield* WatchFeed.Service
  const remoteWatch = yield* RemoteWatch.Service
  const remoteService = yield* Remote.Service
  const bus = yield* Bus.Service
  const integration = yield* Integration.Service
  const starts = yield* Starts.Service
  const seenLocked = yield* KeyedMutex.make<string>()

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

      if (!session || session.entry) {
        const identity = yield* db.session.sessionIdentity(id)

        if (identity?.entry) {
          const directory = yield* db.project.projectDirectory(identity.projectId)

          const name =
            directory !== undefined && directory !== ""
              ? directory.slice(directory.lastIndexOf("/") + 1)
              : identity.projectId

          return yield* new NoSuchSession({
            id,
            message: `${id} is the session you opened in a terminal (project ${name}); stop it in that terminal.`,
          })
        }

        return yield* new NoSuchSession({ id, message: `no session ${id}` })
      }

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

  const linkProject = (method: "Session.Link" | "Session.Unlink") =>
    scope(method).pipe(
      Effect.map((project) => project.id),
      Effect.catchTag("NotInRepository", (e) => Effect.fail(new Forbidden({ method, message: e.message }))),
    )

  const resolveEndpoint = (method: string, projectId: string, ref: SessionRef) =>
    Effect.gen(function* () {
      if (ref.machine === undefined) {
        const id = yield* resolveLiveTarget(
          db,
          projectId,
        )(ref.id).pipe(
          Effect.catchTag("LinkRefused", (e) => Effect.fail(new Forbidden({ method, message: e.message }))),
        )

        return { local: true as const, id, remoteId: selfIdentity.id }
      }

      const shown = formatSessionRef(ref)

      if (!SESSION_PREFIX.test(ref.id)) return yield* new NoSuchSession({ id: shown, message: `no session ${shown}` })
      const machineRow = yield* db.remote.machineNamed(ref.machine)

      if (machineRow === undefined)
        return yield* new UnknownMachine({
          machine: ref.machine,
          machines: (yield* db.remote.machines).map((m) => m.name),
        })

      const liveRemote = yield* remoteService.liveSessions(ref.machine, projectId)
      const matches = liveRemote.filter((s) => s.id.startsWith(ref.id))

      if (matches.length === 0) return yield* new NoSuchSession({ id: shown, message: `no session ${shown}` })

      if (matches.length > 1)
        return yield* new AmbiguousSession({
          prefix: ref.id,
          matches: matches.map((s) => `${ref.machine}/${s.id}`),
        })

      return { local: false as const, machine: ref.machine, id: matches[0]!.id, remoteId: machineRow.remoteId }
    })

  const applyEndpointPairs = (
    pairs: ReadonlyArray<readonly [ResolvedEndpoint, ResolvedEndpoint]>,
    mode: "link" | "unlink",
  ) =>
    Effect.gen(function* () {
      const localEdges: Array<{ readonly from: string; readonly to: string; readonly remote?: string | undefined }> = []

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
    method: "Session.Link" | "Session.Unlink",
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
    const pairs: Array<readonly [ResolvedEndpoint, ResolvedEndpoint]> = []
    const seen = new Set<string>()

    const push = (from: ResolvedEndpoint, to: ResolvedEndpoint) => {
      const fk = endpointKey(from)
      const tk = endpointKey(to)

      if (fk === tk) return
      const key = `${fk}\0${tk}`

      if (seen.has(key)) return
      seen.add(key)
      pairs.push([from, to])
    }

    for (const from of fromEndpoints) push(from, spawnedEp)

    for (const to of toEndpoints) push(spawnedEp, to)

    for (const target of withEndpoints) {
      push(target, spawnedEp)
      push(spawnedEp, target)
    }

    return pairs.length > 0 ? applyEndpointPairs(pairs, "link") : Effect.void
  }

  return {
    Spawn: (input) =>
      Effect.gen(function* () {
        const c = yield* Caller

        if (!Predicate.isTagged(c, "Session")) return yield* new NoCallingSession()
        const project = yield* projectOf(c, "Spawn")

        if (input.machine !== undefined) {
          const resolve = (ref: SessionRef) => resolveEndpoint("Spawn", project.id, ref)
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

        const anyRemoteLink = [...(input.from ?? []), ...(input.to ?? []), ...(input.with ?? [])].some(
          (ref) => ref.machine !== undefined,
        )

        const resolve = (ref: SessionRef) => resolveEndpoint("Spawn", project.id, ref)
        const fromEndpoints = anyRemoteLink ? yield* Effect.forEach(input.from ?? [], resolve) : []
        const toEndpoints = anyRemoteLink ? yield* Effect.forEach(input.to ?? [], resolve) : []
        const withEndpoints = anyRemoteLink ? yield* Effect.forEach(input.with ?? [], resolve) : []

        const spawned = yield* sessions
          .spawn({
            machine: yield* machineFromCaller("Spawn", input),
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
            ...(!anyRemoteLink && {
              from: input.from?.map((ref) => ref.id),
              to: input.to?.map((ref) => ref.id),
              with: input.with?.map((ref) => ref.id),
            }),
          })
          .pipe(
            Effect.catchTag("LinkRefused", (e) => Effect.fail(new Forbidden({ method: "Spawn", message: e.message }))),
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

    "Session.Link": ({ spec }) =>
      linkProject("Session.Link").pipe(
        Effect.flatMap((projectId) => applyCrossMachineEdges("Session.Link", projectId, spec, "link")),
      ),

    "Session.Unlink": ({ spec }) =>
      linkProject("Session.Unlink").pipe(
        Effect.flatMap((projectId) => applyCrossMachineEdges("Session.Unlink", projectId, spec, "unlink")),
      ),

    Republish: () => sessions.republish,

    Send: (p) =>
      routed.Send(p, (input) =>
        Effect.gen(function* () {
          const caller = yield* Caller

          if (Predicate.isTagged(caller, "Session"))
            return yield* sessions
              .admit(caller, input, p.message, p.request)
              .pipe(
                Effect.catchTag("SendRefused", (e) =>
                  Effect.fail(new Forbidden({ method: "Send", message: e.message })),
                ),
              )
          const { c, scope } = yield* reach("Send")

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
              method: "Send",
              message: `${target} was not started by the session that called, and it did not start it; a message goes only to the session that started it or to a session it started`,
            })
          const from = Predicate.isTagged(caller, "Remote") ? yield* remoteSender(caller, p.from) : undefined
          yield* sessions.deliverTo(target, p.message, from ?? { type: "user" }, p.request)

          return { id: target }
        }),
      ),

    Interrupt: (p) =>
      routed.Interrupt(p, (id) =>
        managed("Interrupt", id).pipe(
          Effect.flatMap((id) => sessions.interrupt(id).pipe(Effect.map((out) => ({ id, ...out })))),
        ),
      ),

    Stop: (p) =>
      routed.Stop(p, (id) =>
        managed("Stop", id).pipe(
          Effect.flatMap((id) =>
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

              const { message } = yield* sessions.stop(id, by)

              return { id, message }
            }),
          ),
        ),
      ),

    Archive: (p) =>
      routed.Archive(p, (id) =>
        managed("Archive", id).pipe(
          Effect.flatMap((id) =>
            sessions
              .archive(id, { keepWorktree: p.keepWorktree })
              .pipe(
                Effect.catchTag("RuntimeError", (e) =>
                  e.code === "unreachable"
                    ? Effect.fail(new RuntimeUnreachable({ session: id, message: e.message }))
                    : Effect.die(e),
                ),
              ),
          ),
          Effect.map((out) => out ?? null),
        ),
      ),

    Get: (p) =>
      routed.Get(p, (input) =>
        Effect.gen(function* () {
          const id = yield* db.session.resolveSession(input, (yield* reach("Get")).scope)
          const row = yield* sessions.get(id)

          const session = Listing.toInfo(
            row,
            (yield* db.session.sessionBriefs([id])).get(id),
            (yield* starts.choices).get(id),
          )

          return {
            ...session,
            reply: (yield* db.session.latestReply(id)) ?? null,
          }
        }),
      ),

    Peek: (p) =>
      routed.Peek(p, (id) =>
        managed("Peek", id).pipe(
          Effect.flatMap((id) => sessions.peek(id, p.lines ?? 30)),
          Effect.map((text) => ({ text })),
        ),
      ),

    Events: ({ session, after, follow }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* cliOnly("Events")

          if (after !== undefined && session === undefined)
            return yield* new Forbidden({
              method: "Events",
              message: "after resumes one session's facts; give the session too",
            })

          const id =
            session === undefined
              ? undefined
              : yield* db.session
                  .resolveSession(session)
                  .pipe(
                    Effect.catchTag("AmbiguousSession", (e) =>
                      Effect.fail(new NoSuchSession({ id: session, message: e.message })),
                    ),
                  )

          return bus.log({ aggregate: id, after, follow: follow === true }).pipe(
            Stream.map(({ aggregate, seq, at, type, data }) => ({
              aggregate,
              seq,
              at,
              type,
              data: JSON.parse(data),
            })),
          )
        }),
      ),

    Watch: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const caller = yield* Caller

          if (!Predicate.isTagged(caller, "Remote")) yield* userOnly("Watch")

          const localChanges = yield* watchFeed.subscribe
          const sessionRows = yield* watched(yield* listed(ListScope.All(), false))
          const localProjects = yield* snapshotProjects(sessionRows)

          if (Predicate.isTagged(caller, "Remote")) {
            const snapshot: WatchEvent = Listing.WatchEvents.Snapshot({
              projects: localProjects,
              sessions: sessionRows,
              machines: [],
            })

            return Stream.concat(Stream.make(snapshot), localChanges)
          }

          const remoteChanges = yield* remoteWatch.subscribe
          const remote = yield* remoteWatch.snapshot

          const snapshot: WatchEvent = Listing.WatchEvents.Snapshot({
            projects: [...localProjects, ...remote.projects],
            sessions: [...sessionRows, ...remote.sessions],
            machines: remote.machines,
          })

          return Stream.concat(Stream.make(snapshot), Stream.merge(localChanges, remoteChanges))
        }),
      ),

    "Session.Seen": ({ id, finished }) =>
      Effect.gen(function* () {
        yield* cliOnly("Session.Seen")
        const identity = yield* db.session.sessionIdentity(id)

        if (identity === undefined) return yield* new NoSuchSession({ id, message: `no session ${id}` })
        const at = yield* db.session.getSession(id)
        const terminal = at === undefined ? null : terminalOf(at)

        if (terminal === null) return
        const rt = runtimes.find(terminal.runtime)

        if (rt === undefined || rt.seen === undefined || rt.see === undefined) return
        const see = rt.see

        const unreachable = (e: { readonly message: string }) =>
          new RuntimeUnreachable({ session: id, message: e.message })

        const seen = rt.seen
        yield* Effect.gen(function* () {
          const now = yield* seen(terminal.target).pipe(Effect.mapError(unreachable))

          if (raisesSeen(now, finished)) yield* see(terminal.target, finished).pipe(Effect.mapError(unreachable))
        }).pipe(seenLocked.withLock(`${terminal.runtime}\n${canonicalTarget(terminal.target)}`))
      }),

    "Session.Ready": ({ id, pid, conversation }, { headers }) =>
      Effect.gen(function* () {
        yield* selfCaller("Session.Ready", id)
        const read = reader(headers)

        if (conversation !== undefined) {
          const row = yield* db.session.sessionIdentity(id)

          if (row?.entry === true && conversation.harness === row.harness)
            yield* integration.conversation(id, conversation.id, processOf(read))

          return {}
        }

        const current = yield* integration.ready(id, pid, integrationOf(read), processOf(read))

        return current === undefined ? {} : { process: current }
      }),

    "Agents.Outdated": () => cliOnly("Agents.Outdated").pipe(Effect.andThen(sessions.outdated)),

    "Agents.Restart": ({ ids, after }) =>
      cliOnly("Agents.Restart").pipe(Effect.andThen(sessions.restartLater(ids, after))),
  } satisfies Handlers
})

export const layer = group([
  "Spawn",
  "Session.Link",
  "Session.Unlink",
  "Republish",
  "Send",
  "Interrupt",
  "Stop",
  "Archive",
  "Get",
  "Peek",
  "Events",
  "Watch",
  "Session.Seen",
  "Session.Ready",
  "Agents.Outdated",
  "Agents.Restart",
]).toLayer(make)
