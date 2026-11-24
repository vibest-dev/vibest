import { formatTerminalTarget } from "@vibest/schema/terminal"
import { Effect, Option, PubSub, Schema, Stream } from "effect"

import type { Launch } from "./launch.ts"
import type { Transform } from "./registration.ts"

export type TerminalTarget = Readonly<Record<string, string>>

export type Terminal = TerminalTarget

export type TerminalSchema<T> = Schema.Codec<T, TerminalTarget>

export interface Remote {
  readonly id: string
  readonly target: string
  readonly link: Readonly<Record<string, string>>
}

export interface Located<T = TerminalTarget> {
  readonly missing: boolean
  readonly terminals: ReadonlyMap<string, T>
  readonly as?: string
  readonly note?: string
}

export class RuntimeError extends Schema.TaggedError<RuntimeError>()("RuntimeError", {
  code: Schema.Literals(["not_found", "busy", "unreachable", "incompatible", "failed"]),
  message: Schema.String,
}) {}

export type RuntimeStatus =
  | { readonly status: "online" }
  | { readonly status: "offline" | "blocked"; readonly reason: string }

export type AgentState = "idle" | "working" | "blocked" | "unknown"

export interface RuntimeCheck {
  readonly ok: boolean
  readonly subject?: string
  readonly text: string
  readonly fix?: string
}

export interface RuntimeReport {
  readonly name: string
  readonly checks: ReadonlyArray<RuntimeCheck>
}

export interface Seen {
  readonly finished: number
  readonly seen: number | null
}

export type RuntimeEvent<T = TerminalTarget> =
  | { readonly type: "exited"; readonly terminal: T }
  | { readonly type: "seen"; readonly terminal: T }
  | { readonly type: "state"; readonly terminal: T; readonly state: AgentState }
  | { readonly type: "reset" }

export const eventsFrom = <T = TerminalTarget>(
  pubsub: PubSub.PubSub<RuntimeEvent<T>>,
): Stream.Stream<RuntimeEvent<T>> =>
  Stream.unwrap(
    PubSub.subscribe(pubsub).pipe(
      Effect.map((subscription) =>
        Stream.succeed<RuntimeEvent<T>>({ type: "reset" }).pipe(Stream.concat(Stream.fromSubscription(subscription))),
      ),
    ),
  )

type CallerValues = Readonly<Record<string, string | undefined>>

export interface RuntimeCaller<T = TerminalTarget> {
  readonly env: ReadonlyArray<string>
  readonly terminal: (env: CallerValues) => Effect.Effect<T | undefined, unknown>
  readonly ready?: (env: CallerValues) => Effect.Effect<boolean, unknown>
  readonly missing?: string
  readonly target?: (env: CallerValues, named?: string) => string | undefined
}

export interface OpenInput<T = TerminalTarget> {
  readonly project: string
  readonly cwd: string
  readonly launch: Launch
  readonly label: string
  readonly parent?: T
  readonly near?: T
  readonly split?: boolean
  readonly focus?: boolean
  readonly target?: string
  readonly remote?: boolean
}

export interface RuntimeDefinition<T = TerminalTarget> {
  readonly id: string
  readonly name?: string
  readonly caller?: RuntimeCaller<T>
  readonly status: () => Effect.Effect<RuntimeStatus>
  readonly format?: (terminal: T) => string

  readonly open: (input: OpenInput<T>) => Effect.Effect<T, RuntimeError>
  readonly send: (
    terminal: T,
    input: { readonly text?: string; readonly keys?: ReadonlyArray<string> },
  ) => Effect.Effect<void, RuntimeError>
  readonly read: (terminal: T, lines: number) => Effect.Effect<string, RuntimeError>
  readonly process: (
    terminal: T,
  ) => Effect.Effect<{ readonly running: boolean; readonly exitCode?: number }, RuntimeError>
  readonly close: (terminal: T) => Effect.Effect<void, RuntimeError>
  readonly events: Stream.Stream<RuntimeEvent<T>>

  readonly state?: (terminal: T) => Effect.Effect<AgentState, RuntimeError>
  readonly session?: (terminal: T) => Effect.Effect<string | null, RuntimeError>
  readonly seen?: (terminal: T) => Effect.Effect<Seen, RuntimeError>
  readonly see?: (terminal: T, finished: number) => Effect.Effect<void, RuntimeError>
  readonly run?: (terminal: T, launch: Launch) => Effect.Effect<void, RuntimeError>
  readonly focus?: (terminal: T) => Effect.Effect<void, RuntimeError>
  readonly present?: (terminal: T, info: Readonly<Record<string, string>>) => Effect.Effect<void, RuntimeError>
  readonly doctor?: (harnesses: ReadonlyArray<string>) => Effect.Effect<RuntimeReport>
  readonly attach?: (target: string | undefined, terminal?: T) => ReadonlyArray<string>
  readonly link?: () => Effect.Effect<Readonly<Record<string, string>> | undefined>
  readonly locate?: (remote: Remote, sessions: ReadonlyMap<string, T>) => Effect.Effect<Located<T>>
}

export interface TypedRuntimeDefinition<T> extends RuntimeDefinition<T> {
  readonly terminal: TerminalSchema<T>
}

export const define = <T>(spec: TypedRuntimeDefinition<T>): RuntimeDefinition => {
  const decodeOpt = Schema.decodeUnknownOption(spec.terminal)
  const encodeSync = Schema.encodeUnknownSync(spec.terminal)

  const decode = (raw: TerminalTarget): Effect.Effect<T, RuntimeError> => {
    const parsed = decodeOpt(raw)

    return Option.isSome(parsed)
      ? Effect.succeed(parsed.value)
      : Effect.fail(new RuntimeError({ code: "not_found", message: `invalid ${spec.id} terminal target` }))
  }

  const encode = (value: T): TerminalTarget => encodeSync(value)

  const wrap =
    <A>(fn: (terminal: T) => Effect.Effect<A, RuntimeError>) =>
    (raw: TerminalTarget) =>
      Effect.flatMap(decode(raw), fn)

  const caller: RuntimeCaller | undefined =
    spec.caller === undefined
      ? undefined
      : {
          env: spec.caller.env,
          terminal: (env) =>
            spec.caller!.terminal(env).pipe(Effect.map((found) => (found === undefined ? undefined : encode(found)))),
          ...(spec.caller.ready !== undefined && { ready: spec.caller.ready }),
          ...(spec.caller.missing !== undefined && { missing: spec.caller.missing }),
          ...(spec.caller.target !== undefined && { target: spec.caller.target }),
        }

  return {
    id: spec.id,
    ...(spec.name !== undefined && { name: spec.name }),
    ...(caller !== undefined && { caller }),
    status: spec.status,
    ...(spec.format !== undefined && {
      format: (raw: TerminalTarget) => {
        const parsed = decodeOpt(raw)

        return Option.isSome(parsed) ? spec.format!(parsed.value) : formatTerminalTarget(raw)
      },
    }),
    open: (input) =>
      Effect.gen(function* () {
        const parent = input.parent === undefined ? undefined : yield* decode(input.parent)
        const near = input.near === undefined ? undefined : yield* decode(input.near)

        const opened = yield* spec.open({
          project: input.project,
          cwd: input.cwd,
          launch: input.launch,
          label: input.label,
          ...(parent !== undefined && { parent }),
          ...(near !== undefined && { near }),
          ...(input.split !== undefined && { split: input.split }),
          ...(input.focus !== undefined && { focus: input.focus }),
          ...(input.target !== undefined && { target: input.target }),
          ...(input.remote !== undefined && { remote: input.remote }),
        })

        return encode(opened)
      }),
    send: (raw, input) => Effect.flatMap(decode(raw), (t) => spec.send(t, input)),
    read: (raw, lines) => Effect.flatMap(decode(raw), (t) => spec.read(t, lines)),
    process: wrap(spec.process),
    close: wrap(spec.close),
    events: spec.events.pipe(
      Stream.map((event): RuntimeEvent =>
        event.type === "reset" ? event : { ...event, terminal: encode(event.terminal) },
      ),
    ),
    ...(spec.state !== undefined && { state: wrap(spec.state) }),
    ...(spec.session !== undefined && { session: wrap(spec.session) }),
    ...(spec.seen !== undefined && { seen: wrap(spec.seen) }),
    ...(spec.see !== undefined && {
      see: (raw, finished) => Effect.flatMap(decode(raw), (t) => spec.see!(t, finished)),
    }),
    ...(spec.run !== undefined && { run: (raw, launch) => Effect.flatMap(decode(raw), (t) => spec.run!(t, launch)) }),
    ...(spec.focus !== undefined && { focus: wrap(spec.focus) }),
    ...(spec.present !== undefined && {
      present: (raw, info) => Effect.flatMap(decode(raw), (t) => spec.present!(t, info)),
    }),
    ...(spec.doctor !== undefined && { doctor: spec.doctor }),
    ...(spec.attach !== undefined && {
      attach: (target, raw) => {
        const parsed = raw === undefined ? undefined : Option.getOrUndefined(decodeOpt(raw))

        return spec.attach!(target, parsed)
      },
    }),
    ...(spec.link !== undefined && { link: spec.link }),
    ...(spec.locate !== undefined && {
      locate: (remote, sessions) =>
        Effect.gen(function* () {
          const decoded = new Map<string, T>()

          for (const [id, raw] of sessions) {
            const parsed = decodeOpt(raw)

            if (Option.isSome(parsed)) decoded.set(id, parsed.value)
          }

          const located = yield* spec.locate!(remote, decoded)
          const encoded = new Map<string, TerminalTarget>()

          for (const [id, t] of located.terminals) encoded.set(id, encode(t))

          return { ...located, terminals: encoded }
        }),
    }),
  }
}

export interface RuntimeEditor {
  add(definition: RuntimeDefinition): void
}

export interface RuntimeDomain {
  readonly transform: Transform<RuntimeEditor>
}
