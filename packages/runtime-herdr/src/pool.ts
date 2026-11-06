import { RuntimeUnreachable as HerdrUnreachable, type RuntimeLocation as HerdrLocation } from "@vibest/schema/session"
import {
  Context,
  Duration,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import {
  Herdr,
  HerdrProtocolMismatch,
  type HerdrShape,
  type PushFrame,
  SocketConnector,
  type Subscription,
} from "effect-herdr-sdk"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface SessionEvent {
  readonly session: string
  readonly frame: PushFrame
}

export const SUBSCRIPTIONS: ReadonlyArray<Subscription> = [
  { type: "pane.updated" },
  { type: "pane.closed" },
  { type: "pane.exited" },
  { type: "pane.moved" },
  { type: "workspace.closed" },
]

const START_TIMEOUT = Duration.seconds(10)

const SessionList = Schema.fromJsonString(
  Schema.Struct({
    sessions: Schema.Array(Schema.Struct({ name: Schema.String, socket_path: Schema.String, running: Schema.Boolean })),
  }),
)

const RECONNECT_BACKOFF = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(30)))),
)

export class HerdrPool extends Context.Service<
  HerdrPool,
  {
    readonly resolve: (location: HerdrLocation) => Effect.Effect<string, HerdrUnreachable | HerdrProtocolMismatch>
    readonly client: (session: string) => Effect.Effect<HerdrShape, HerdrUnreachable | HerdrProtocolMismatch>
    readonly events: Stream.Stream<SessionEvent>
    readonly restarts: Stream.Stream<string>
    readonly sessions: Effect.Effect<ReadonlyArray<string>>
  }
>()("vibest/runtime-herdr/HerdrPool") {
  static readonly layer = Layer.effect(
    HerdrPool,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Effect.scope
      const connector = yield* Effect.context<SocketConnector>()
      const herdr = (socketPath: string) => Herdr.make(socketPath).pipe(Effect.provideContext(connector))
      const pubsub = yield* PubSub.unbounded<SessionEvent>()
      const restarts = yield* PubSub.unbounded<string>()
      const sessions = yield* SynchronizedRef.make(
        HashMap.empty<
          string,
          { readonly socketPath: string; readonly mismatch: Option.Option<HerdrProtocolMismatch> }
        >(),
      )
      const setMismatch = (session: string, mismatch: Option.Option<HerdrProtocolMismatch>) =>
        SynchronizedRef.update(
          sessions,
          HashMap.modify(session, (s) => ({ ...s, mismatch })),
        )

      const verifiedClient = (session: string, socketPath: string) =>
        herdr(socketPath).pipe(
          Effect.tap(Herdr.verifyProtocol),
          Effect.catchTags({
            HerdrError: (e) => Effect.fail(new HerdrUnreachable({ session, message: `ping: ${e.message}` })),
            HerdrTransportError: (e) => Effect.fail(new HerdrUnreachable({ session, message: `ping: ${e.message}` })),
          }),
        )

      const listSessions = (session: string) =>
        spawner.string(ChildProcess.make("herdr", ["session", "list", "--json"])).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(SessionList)),
          Effect.map((list) => list.sessions),
          Effect.mapError((e) => new HerdrUnreachable({ session, message: `herdr session list: ${e.message}` })),
        )

      const watch = (session: string, socketPath: string) =>
        Effect.gen(function* () {
          const connectedBefore = yield* Ref.make(false)
          const connect = verifiedClient(session, socketPath).pipe(
            Effect.tap(() =>
              Ref.getAndSet(connectedBefore, true).pipe(
                Effect.flatMap((was) => (was ? PubSub.publish(restarts, session).pipe(Effect.asVoid) : Effect.void)),
              ),
            ),
            Effect.tapError((e) =>
              e._tag === "HerdrProtocolMismatch" ? setMismatch(session, Option.some(e)) : Effect.void,
            ),
            Effect.tap(() => setMismatch(session, Option.none())),
            Effect.map((h) => h.subscribe(SUBSCRIPTIONS)),
            Stream.unwrap,
            Stream.runForEach((frame) => PubSub.publish(pubsub, { session, frame })),
          )
          yield* connect.pipe(Effect.retry(RECONNECT_BACKOFF), Effect.andThen(Effect.sleep("1 second")), Effect.forever)
        })

      const remember = (session: string, socketPath: string) =>
        SynchronizedRef.modifyEffect(sessions, (map) =>
          Option.match(HashMap.get(map, session), {
            onSome: (known) =>
              Effect.succeed([undefined, HashMap.set(map, session, { ...known, socketPath })] as const),
            onNone: () =>
              verifiedClient(session, socketPath).pipe(
                Effect.andThen(Effect.forkIn(watch(session, socketPath), scope)),
                Effect.as([undefined, HashMap.set(map, session, { socketPath, mismatch: Option.none() })] as const),
              ),
          }),
        )

      const startHeadlessServer = (session: string) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("herdr", ["server", "--session", session], {
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          yield* handle.unref
        }).pipe(
          Effect.scoped,
          Effect.mapError(
            (e) => new HerdrUnreachable({ session, message: `herdr server --session ${session}: ${e.message}` }),
          ),
          Effect.andThen(
            listSessions(session).pipe(
              Effect.map((list) => list.find((s) => s.name === session && s.running)),
              Effect.flatMap((found) =>
                found
                  ? fs.exists(found.socket_path).pipe(Effect.map((ok) => (ok ? found.socket_path : undefined)))
                  : Effect.succeed(undefined),
              ),
              Effect.orElseSucceed(() => undefined),
              Effect.repeat({
                until: (socketPath) => socketPath !== undefined,
                schedule: Schedule.spaced("200 millis"),
              }),
              Effect.timeoutOrElse({
                duration: START_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new HerdrUnreachable({
                      session,
                      message: `herdr server --session ${session} did not come up in ${Duration.format(START_TIMEOUT)}`,
                    }),
                  ),
              }),
              Effect.map((socketPath) => socketPath!),
            ),
          ),
        )

      const resolve = (location: HerdrLocation) =>
        Effect.gen(function* () {
          if ("socketPath" in location) {
            const found = (yield* listSessions("?")).find((s) => s.socket_path === location.socketPath)
            if (!found)
              return yield* new HerdrUnreachable({
                session: "?",
                message: `no herdr session listens on ${location.socketPath}`,
              })
            yield* remember(found.name, found.socket_path)
            return found.name
          }
          const session = location.session
          const found = (yield* listSessions(session)).find((s) => s.name === session)
          yield* remember(session, found?.running ? found.socket_path : yield* startHeadlessServer(session))
          return session
        })

      const client = (session: string) =>
        Effect.gen(function* () {
          const known = HashMap.get(yield* SynchronizedRef.get(sessions), session)
          if (Option.isSome(known)) {
            if (Option.isSome(known.value.mismatch)) return yield* known.value.mismatch.value
            return yield* herdr(known.value.socketPath)
          }
          const found = (yield* listSessions(session)).find((s) => s.name === session && s.running)
          if (!found)
            return yield* new HerdrUnreachable({ session, message: `herdr session ${session} is not running` })
          yield* remember(session, found.socket_path)
          return yield* herdr(found.socket_path)
        })

      return HerdrPool.of({
        resolve,
        client,
        events: Stream.fromPubSub(pubsub),
        restarts: Stream.fromPubSub(restarts),
        sessions: SynchronizedRef.get(sessions).pipe(Effect.map((map) => Array.from(HashMap.keys(map)))),
      })
    }),
  )
}
