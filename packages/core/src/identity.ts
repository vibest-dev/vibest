import { ID, randomId } from "@vibest/schema/id"
import { Context, Duration, Effect, FileSystem, Option, Schema } from "effect"

import { LayerNode } from "./effect/layer-node.ts"

export const HOST_ID_TIMEOUT = Duration.seconds(2)
export const MACHINE_ID_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const

export const IdentityFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  machine_id: Schema.NullOr(Schema.String),
})
export type IdentityFile = typeof IdentityFile.Type
const IdentityJson = Schema.fromJsonString(IdentityFile)

export class VibestdIdentity extends Context.Service<VibestdIdentity, { readonly id: string; readonly name: string }>()(
  "vibest/VibestdIdentity",
) {
  static readonly node = LayerNode.unbound(VibestdIdentity)
}

export class IdentityUnreadable extends Schema.TaggedError<IdentityUnreadable>()("IdentityUnreadable", {
  file: Schema.String,
}) {
  override get message() {
    return `${this.file} is not a vibest identity file: move it aside and start again (this machine then gets a new identity)`
  }
}

export interface HostFacts {
  readonly name: string
  readonly id: Effect.Effect<string | undefined>
  readonly pid: number
}

export const ioregUuid = (text: string) => /"IOPlatformUUID" = "([^"]+)"/.exec(text)?.[1]

export const shortHostName = (hostname: string) => hostname.split(".")[0] || hostname

export const readHostId = (source: {
  readonly ioreg?: Effect.Effect<string, unknown> | undefined
  readonly files: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    if (source.ioreg !== undefined) return ioregUuid(yield* source.ioreg)
    const fs = yield* FileSystem.FileSystem
    for (const file of source.files) {
      const text = yield* fs.readFileString(file).pipe(Effect.option)
      const line = Option.getOrUndefined(text)?.split("\n")[0]?.trim()
      if (line) return line
    }
    return undefined
  }).pipe(
    Effect.timeoutOrElse({ duration: HOST_ID_TIMEOUT, orElse: () => Effect.succeed(undefined) }),
    Effect.orElseSucceed(() => undefined),
  )

const writeIdentity = (file: string, pid: number, identity: IdentityFile) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmp = `${file}.${pid}.tmp`
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(tmp, { flag: "w", mode: 0o600 })
        yield* handle.writeAll(new TextEncoder().encode(`${Schema.encodeSync(IdentityJson)(identity)}\n`))
        yield* handle.sync
      }),
    )
    yield* fs.rename(tmp, file)
  })

export const loadIdentity = (file: string, host: HostFacts) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const hostId = yield* host.id
    const fresh = (): IdentityFile => ({ id: randomId(), name: shortHostName(host.name), machine_id: hostId ?? null })
    if (!(yield* fs.exists(file))) {
      const made = fresh()
      yield* writeIdentity(file, host.pid, made)
      return { identity: made, warning: undefined }
    }
    const stored = yield* fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(IdentityJson)),
      Effect.mapError(() => new IdentityUnreadable({ file })),
    )
    if (!ID.test(stored.id)) return yield* new IdentityUnreadable({ file })
    if (hostId === undefined) return { identity: stored, warning: "host id unreadable: identity kept" }
    if (stored.machine_id === hostId) return { identity: stored, warning: undefined }
    if (stored.machine_id === null) {
      const filled = { ...stored, machine_id: hostId }
      yield* writeIdentity(file, host.pid, filled)
      return { identity: filled, warning: undefined }
    }
    const renewed = fresh()
    yield* writeIdentity(file, host.pid, renewed)
    return { identity: renewed, warning: "this home came from another machine: a new identity" }
  })
