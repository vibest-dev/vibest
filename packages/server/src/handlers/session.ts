import { Bus, type BusEvent } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { runtimeOf, terminalOf } from "@vibest/core/database/db-rows"
import { keyedLock } from "@vibest/core/effect/keyed-mutex"
import { Integration } from "@vibest/core/integration"
import { raisesSeen } from "@vibest/core/project/activity"
import { Runtimes } from "@vibest/core/runtimes"
import { defaultSessionName, NoSuchSession, Sessions } from "@vibest/core/session"
import { Caller, Forbidden, WatchLagged, type WatchEvent } from "@vibest/protocol/rpc"
import { NoCallingSession, RuntimeUnreachable } from "@vibest/schema/session"
import { Effect, Queue, Stream } from "effect"

import { integrationOf, processOf, reader } from "../gates.ts"
import { type Listing, toInfo } from "../listing.ts"
import type { Checks, Handlers, MethodOf } from "./caller.ts"
import type { RemoteHandlers } from "./remote.ts"

export const WATCH_BACKLOG = 10_000

export const make = (
  { projectOf, machineFromCaller, cliOnly, self }: Checks,
  { reach, routed, spawnOn }: RemoteHandlers,
  { listed, watched, snapshotProjects, watchDeltas }: Listing,
) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const db = yield* Db
    const runtimes = yield* Runtimes
    const bus = yield* Bus
    const integration = yield* Integration
    const seenLocked = keyedLock<string>()

    const startedByPeer = (scope: NonNullable<Parameters<typeof db.resolveSession>[1]>, id: string, direct: boolean) =>
      Effect.gen(function* () {
        if (scope.session === undefined) return true
        const route = direct ? yield* db.creatorOf(id) : yield* db.nearestAlive(id)
        return route !== undefined && "peer" in route && route.peer === scope.peer && route.session === scope.session
      })

    const managed = (method: MethodOf<"owner">, input: string) =>
      Effect.gen(function* () {
        const { c, scope } = yield* reach(method)
        const id = yield* db.resolveSession(input, scope)
        if (c === undefined) {
          if (scope !== undefined && !(yield* startedByPeer(scope, id, false)))
            return yield* new Forbidden({
              method,
              message: `${id} was not started by the session that called; a session manages only the sessions it started`,
            })
          return id
        }
        const session = yield* db.getSession(id)
        if (!session || session.entry) {
          const identity = yield* db.sessionIdentity(id)
          if (identity?.entry) {
            const directory = yield* db.projectDirectory(identity.projectId)
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
        const manager = yield* db.nearestAlive(id)
        if (c._tag === "Session" && (manager === undefined || !("local" in manager) || manager.local !== c.sessionId))
          return yield* new Forbidden({
            method,
            message: `${id} was not started by this session; a session manages only the sessions it started`,
          })
        return id
      })

    return {
      Spawn: (input) =>
        Effect.gen(function* () {
          const c = yield* Caller
          if (c._tag !== "Session") return yield* new NoCallingSession()
          const project = yield* projectOf(c, "Spawn")
          if (input.machine !== undefined) return yield* spawnOn(input.machine, input, c.sessionId, project.id)
          return yield* sessions.spawn({
            machine: yield* machineFromCaller(input),
            root: project.directory,
            projectId: project.id,
            name: input.name ?? defaultSessionName(input.prompt),
            prompt: input.prompt,
            harness: input.harness,
            provider: input.provider,
            model: input.model,
            env: input.env,
            agent: input.agent,
            share: input.share === undefined ? undefined : yield* db.resolveSession(input.share),
            archive: input.archive,
            runtime: input.runtime,
            parentSessionId: c.sessionId,
            request: input.request,
          })
        }),

      Republish: () => sessions.republish,

      Send: (p) =>
        routed.Send(p, (input) =>
          Effect.gen(function* () {
            const caller = yield* Caller
            if (caller._tag === "Session")
              return yield* sessions
                .admit(caller, input, p.message, p.request)
                .pipe(
                  Effect.catchTag("SendRefused", (e) =>
                    Effect.fail(new Forbidden({ method: "Send", message: e.message })),
                  ),
                )
            const { c, scope } = yield* reach("Send")
            const target = yield* db.resolveSession(input, scope)
            if (c === undefined && scope !== undefined && !(yield* startedByPeer(scope, target, true)))
              return yield* new Forbidden({
                method: "Send",
                message: `${target} was not started by the session that called, and it did not start it; a message goes only to the session that started it or to a session it started`,
              })
            yield* sessions.deliverTo(target, p.message, p.request, caller._tag === "Peer" ? caller.session : undefined)
            return { id: target }
          }),
        ),

      Interrupt: (p) =>
        routed.Interrupt(p, (id) =>
          managed("Interrupt", id).pipe(
            Effect.flatMap((id) => sessions.interrupt(id).pipe(Effect.map((out) => ({ id, ...out })))),
          ),
        ),

      Remove: (p) =>
        routed.Remove(p, (id) =>
          managed("Remove", id).pipe(
            Effect.flatMap((id) =>
              sessions
                .remove(id, { keepWorktree: p.keepWorktree })
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
            const id = yield* db.resolveSession(input, (yield* reach("Get")).scope)
            const row = yield* sessions.get(id)
            const session = toInfo(row, (yield* db.sessionBriefs([id])).get(id))
            return {
              ...session,
              reply: (yield* db.latestReply(id)) ?? null,
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
                : yield* db
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
                data: JSON.parse(data) as unknown,
              })),
            )
          }),
        ),

      Watch: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* cliOnly("Watch")
            const subscription = yield* bus.subscribe()
            const backlog = yield* Queue.bounded<BusEvent, WatchLagged>(WATCH_BACKLOG)
            yield* Stream.fromSubscription(subscription).pipe(
              Stream.runForEach((event) =>
                Queue.offerUnsafe(backlog, event)
                  ? Effect.void
                  : Queue.fail(
                      backlog,
                      new WatchLagged({
                        message: `Watch fell ${WATCH_BACKLOG} events behind; reconnect for a new Snapshot`,
                      }),
                    ),
              ),
              Effect.forkScoped,
            )
            const sessionRows = yield* watched(yield* listed({ _tag: "All" }, false))
            const snapshot: WatchEvent = {
              _tag: "Snapshot",
              projects: yield* snapshotProjects(sessionRows),
              sessions: sessionRows,
            }
            return Stream.concat(
              Stream.make(snapshot),
              Stream.fromEffectRepeat(Queue.takeAll(backlog).pipe(Effect.flatMap(watchDeltas))).pipe(
                Stream.flattenIterable,
              ),
            )
          }),
        ),

      "Session.Seen": ({ id, finished }) =>
        Effect.gen(function* () {
          yield* cliOnly("Session.Seen")
          const identity = yield* db.sessionIdentity(id)
          if (identity === undefined) return yield* new NoSuchSession({ id, message: `no session ${id}` })
          const at = yield* db.getSession(id)
          if (at === undefined || !runtimeOf(at) || terminalOf(at).id === "") return
          const address = terminalOf(at)
          const rt = runtimes.find(runtimeOf(at))
          if (rt === undefined || rt.seen === undefined || rt.see === undefined) return
          const see = rt.see
          const unreachable = (e: { readonly message: string }) =>
            new RuntimeUnreachable({ session: id, message: e.message })
          const seen = rt.seen
          yield* Effect.gen(function* () {
            const now = yield* seen(address).pipe(Effect.mapError(unreachable))
            if (raisesSeen(now, finished)) yield* see(address, finished).pipe(Effect.mapError(unreachable))
          }).pipe(seenLocked.withLock(`${runtimeOf(at)}\n${address.machine}\n${address.id}`))
        }),

      "Session.Ready": ({ id, pid, conversation }, { headers }) =>
        Effect.gen(function* () {
          yield* self("Session.Ready", id)
          const read = reader(headers)
          if (conversation !== undefined) {
            const row = yield* db.sessionIdentity(id)
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
