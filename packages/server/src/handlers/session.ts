import { raisesSeen } from "@vibest/core/activity"
import { Bus, type EngineEvent } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Integration } from "@vibest/core/integration"
import { keyedLock } from "@vibest/core/keyed-lock"
import { Runtimes } from "@vibest/core/runtimes"
import { defaultSessionName, NoSuchSession, Sessions } from "@vibest/core/sessions"
import { Caller, type CallerShape, Forbidden, type PayloadOf, WatchLagged, type WatchEvent } from "@vibest/protocol/rpc"
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

    const managed = (method: MethodOf<"owner">, input: string) =>
      Effect.gen(function* () {
        const { c, scope } = yield* reach(method)
        const id = yield* db.resolveSession(input, scope)
        if (c === undefined) return id
        const session = yield* db.getSession(id)
        if (!session) {
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
        if (c._tag === "Entry" && session.projectId !== c.projectId)
          return yield* new Forbidden({
            method,
            message: `${id} belongs to another entry session; only it or the user may manage it`,
          })
        return id
      })

    const sendWithinProject = (
      caller: Extract<CallerShape, { readonly _tag: "Session" | "Entry" }>,
      input: string,
      p: PayloadOf<"Send">,
    ) =>
      Effect.gen(function* () {
        const toOrigin =
          caller._tag === "Session" ? yield* db.sendToOrigin(caller.sessionId, input, p.message) : undefined
        if (toOrigin === false)
          return yield* new NoSuchSession({
            id: input,
            message: `${input} is on another machine that vibestd does not know; nothing was sent`,
          })
        if (toOrigin === true) return { id: input }
        const id = yield* db.resolveSession(input)
        const target = yield* db.sessionIdentity(id)
        if (target?.projectId !== caller.projectId)
          return yield* new Forbidden({
            method: "Send",
            message: `${id} belongs to another entry session's project; a message goes only to an agent of your own project`,
          })
        const allowed = Effect.gen(function* () {
          if (yield* db.maySend(caller.sessionId, id)) return true
          const creator = yield* db.addressedCreator(caller.sessionId)
          return yield* new Forbidden({
            method: "Send",
            message: `${id} is not the agent that started you, and you did not start it${creator === undefined ? "" : `; you may send to ${creator}`}`,
          })
        })
        if (target.entry) {
          yield* allowed
          const row = yield* db.insertSend(id, p.message, p.request, caller.sessionId)
          if (!row)
            return yield* new NoSuchSession({
              id,
              message: `${id} is the entry session of this project and is not running`,
            })
          return { id }
        }
        const session = yield* db.getSession(id)
        if (!session || session.metadata.archived || session.metadata.removed) {
          const entry = (yield* db.entryOf(caller.projectId))?.id
          return yield* new NoSuchSession({
            id,
            message: `${id} was archived${entry === undefined ? "" : `; the entry session of this project is ${entry}`}`,
          })
        }
        yield* allowed
        yield* sessions.send(id, p.message, p.request, caller.sessionId)
        return { id }
      })

    return {
      Spawn: (input) =>
        Effect.gen(function* () {
          const c = yield* Caller
          if (c._tag !== "Entry" && c._tag !== "Session") return yield* new NoCallingSession()
          if (input.agent === "coordinator" || input.agent === "main")
            return yield* new Forbidden({
              method: "Spawn",
              message: `${input.agent} is reserved for the entry session (vibest)`,
            })
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
            peer: input.peer === undefined ? undefined : yield* db.resolveSession(input.peer),
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
            if (caller._tag === "Session" || caller._tag === "Entry") return yield* sendWithinProject(caller, input, p)
            const { scope } = yield* reach("Send")
            const target = yield* db.resolveSession(input, scope)
            if ((yield* db.sessionIdentity(target))?.entry) {
              if (!(yield* db.insertSend(target, p.message, p.request)))
                return yield* new NoSuchSession({
                  id: target,
                  message: `${target} is the entry session of this project and is not running`,
                })
              return { id: target }
            }
            const id = yield* managed("Send", input)
            yield* sessions.send(id, p.message, p.request)
            return { id }
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

      Watch: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* cliOnly("Watch")
            const subscription = yield* bus.subscribe
            const backlog = yield* Queue.bounded<EngineEvent, WatchLagged>(WATCH_BACKLOG)
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
          const at = identity.entry ? yield* db.entryOf(identity.projectId) : yield* db.getSession(id)
          if (at?.id !== id || !at.runtime || !at.address || at.address.id === "") return
          const address = at.address
          const rt = runtimes.find(at.runtime)
          if (rt === undefined || rt.seen === undefined || rt.see === undefined) return
          const see = rt.see
          const unreachable = (e: { readonly message: string }) =>
            new RuntimeUnreachable({ session: id, message: e.message })
          const seen = rt.seen
          yield* Effect.gen(function* () {
            const now = yield* seen(address).pipe(Effect.mapError(unreachable))
            if (raisesSeen(now, finished)) yield* see(address, finished).pipe(Effect.mapError(unreachable))
          }).pipe(seenLocked.withLock(`${at.runtime}\n${address.machine}\n${address.id}`))
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
