import { ID, randomId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { Context, Duration, Effect, FileSystem, Layer, Option, Schema } from "effect"

import { LayerNode } from "./effect/layer-node.ts"
import { PlatformNode } from "./effect/platform.ts"

export * as Identity from "./identity.ts"

export const HOST_ID_TIMEOUT = Duration.seconds(2)
export const MACHINE_ID_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const

export const IdentityFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  machine_id: Schema.NullOr(Schema.String),
})
export type IdentityFile = typeof IdentityFile.Type
const IdentityJson = Schema.fromJsonString(IdentityFile)

export class HostFacts extends Context.Service<
  HostFacts,
  {
    readonly name: string
    readonly id: Effect.Effect<string | undefined>
    readonly pid: number
  }
>()("vibest/HostFacts") {}

export const hostFactsNode = LayerNode.unbound(HostFacts)

export interface Interface {
  readonly id: string
  readonly name: string
}

export class Service extends Context.Service<Service, Interface>()("vibest/VibestdIdentity") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const loaded = yield* loadIdentity((yield* Layout).identity, yield* HostFacts)
    if (loaded.warning !== undefined) yield* Effect.logWarning(loaded.warning)
    return { id: loaded.identity.id, name: loaded.identity.name }
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [hostFactsNode, PlatformNode.fileSystem, PlatformNode.layout],
})

export class IdentityUnreadable extends Schema.TaggedError<IdentityUnreadable>()("IdentityUnreadable", {
  file: Schema.String,
}) {
  override get message() {
    return `${this.file} is not a vibest identity file: move it aside and start again (this machine then gets a new identity)`
  }
}

export const ioregUuid = (text: string) => /"IOPlatformUUID" = "([^"]+)"/.exec(text)?.[1]

export const shortHostName = (hostname: string) => hostname.split(".")[0] || hostname

export const readHostId = Effect.fn("Identity.readHostId")(
  function* (source: {
    readonly ioreg?: Effect.Effect<string, unknown> | undefined
    readonly files: ReadonlyArray<string>
  }) {
    if (source.ioreg !== undefined) return ioregUuid(yield* source.ioreg)
    const fs = yield* FileSystem.FileSystem
    for (const file of source.files) {
      const text = yield* fs.readFileString(file).pipe(Effect.option)
      const line = Option.getOrUndefined(text)?.split("\n")[0]?.trim()
      if (line) return line
    }
    return undefined
  },
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

export const loadIdentity = Effect.fn("Identity.loadIdentity")(function* (file: string, host: HostFacts["Service"]) {
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
