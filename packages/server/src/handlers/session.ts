import { raisesSeen } from "@vibest/core/activity"
import { Bus, type EngineEvent } from "@vibest/core/bus"
import { filterCallerEnv, sameTerminal } from "@vibest/core/caller"
import { Db } from "@vibest/core/db"
import { Integration } from "@vibest/core/integration"
import { keyedLock } from "@vibest/core/keyed-lock"
import { Plugins } from "@vibest/core/plugins"
import { Runtimes } from "@vibest/core/runtimes"
import { defaultSessionName, NoSuchSession, Sessions } from "@vibest/core/sessions"
import { Forbidden, WatchLagged, type WatchEvent } from "@vibest/protocol/rpc"
import { RuntimeUnreachable } from "@vibest/schema/session"
import { Effect, Option, Queue, Stream } from "effect"

import { type Listing, toInfo } from "../listing.ts"
import type { Checks, Handlers, MethodOf } from "./caller.ts"
import type { RemoteHandlers } from "./remote.ts"

export const WATCH_BACKLOG = 10_000

export const make = (
  { agent, projectOf, machineFromCaller, cliOnly, self }: Checks,
  { reach, routed, spawnOn }: RemoteHandlers,
  { listed, watched, snapshotProjects, watchDeltas }: Listing,
) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const db = yield* Db
    const runtimes = yield* Runtimes
    const plugins = yield* Plugins
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
          if (identity?.agent === "coordinator") {
            const directory = yield* db.projectDirectory(identity.projectId)
            const name =
              directory !== undefined && directory !== ""
                ? directory.slice(directory.lastIndexOf("/") + 1)
                : identity.projectId
            return yield* new NoSuchSession({
              id,
              message: `${id} is the main agent of project ${name}. Stop it in its terminal.`,
            })
          }
          return yield* new NoSuchSession({ id, message: `no session ${id}` })
        }
        if (c._tag === "Coordinator" && session.projectId !== c.projectId)
          return yield* new Forbidden({
            method,
            message: `${id} belongs to another coordinator; only it or the user may manage it`,
          })
        return id
      })

    return {
      Spawn: (input) =>
        Effect.gen(function* () {
          const c = yield* agent("Spawn")
          if (input.agent === "coordinator" || input.agent === "main")
            return yield* new Forbidden({
              method: "Spawn",
              message: `${input.agent} is reserved for the main agent (vibest)`,
            })
          const project = yield* projectOf(c, "Spawn")
          if (input.machine !== undefined) return yield* spawnOn(input.machine, input, c, project.id)
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
            parentSessionId: c._tag === "Coordinator" ? c.sessionId : undefined,
            request: input.request,
          })
        }),

      Republish: () => sessions.republish,

      Send: (p) =>
        routed.Send(p, (id) =>
          managed("Send", id).pipe(
            Effect.flatMap((id) => sessions.send(id, p.message, p.request).pipe(Effect.as({ id }))),
          ),
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
            return { ...session, result: (yield* db.latestInbox(id, "result")) ?? null }
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

      "Session.Here": ({ id, callerEnv }) =>
        Effect.gen(function* () {
          yield* cliOnly("Session.Here")
          const identity = yield* db.sessionIdentity(id)
          if (identity === undefined) return true
          const at =
            identity.agent === "coordinator" ? yield* db.coordinatorOf(identity.projectId) : yield* db.getSession(id)
          if (at?.id !== id) return false
          if (!at.runtime || !at.address || at.address.id === "" || at.address.machine !== "local") return true
          const spec = (yield* plugins.settled.pipe(Effect.andThen(runtimes.callers))).find(
            (item) => item.id === at.runtime,
          )
          if (spec === undefined) return true
          const terminal = yield* spec.terminal(filterCallerEnv([spec], callerEnv)).pipe(Effect.option)
          return Option.isNone(terminal) || sameTerminal(at.address.id, terminal.value)
        }),

      "Session.Seen": ({ id, turn }) =>
        Effect.gen(function* () {
          yield* cliOnly("Session.Seen")
          const identity = yield* db.sessionIdentity(id)
          if (identity === undefined) return yield* new NoSuchSession({ id, message: `no session ${id}` })
          const at =
            identity.agent === "coordinator" ? yield* db.coordinatorOf(identity.projectId) : yield* db.getSession(id)
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
            if (raisesSeen(now, turn)) yield* see(address, turn).pipe(Effect.mapError(unreachable))
          }).pipe(seenLocked.withLock(`${at.runtime}\n${address.machine}\n${address.id}`))
        }),

      "Session.Ready": ({ id, pid }) =>
        Effect.gen(function* () {
          yield* self("Session.Ready", id)
          yield* integration.ready(id, pid)
        }),

      "Agents.Outdated": () => cliOnly("Agents.Outdated").pipe(Effect.andThen(sessions.outdated)),

      "Agents.Restart": ({ ids, after }) =>
        cliOnly("Agents.Restart").pipe(Effect.andThen(sessions.restartLater(ids, after))),
    } satisfies Handlers
  })
