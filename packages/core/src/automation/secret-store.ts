import { Json } from "@vibest/schema/json"
import { Layout } from "@vibest/schema/layout"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect"

import { PlatformNode } from "../effect/platform.ts"
import { PrivateFile } from "../effect/private-file.ts"

export * as AutomationSecretStore from "./secret-store.ts"

const SecretMapSchema = Schema.Record(Schema.String, Schema.String)
const decodeSecretMap = Schema.decodeUnknownOption(SecretMapSchema)

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const layout = yield* Layout
  const lock = yield* Semaphore.make(1)
  const filePath = path.join(layout.home, "automation-secrets.json")

  const readAll = (): Effect.Effect<Record<string, string>> =>
    fs.readFileString(filePath).pipe(
      Effect.map((raw) => {
        const parsed = Json.parseJsonOption(raw).pipe(Option.flatMap(decodeSecretMap))

        return Option.isSome(parsed) ? { ...parsed.value } : {}
      }),
      Effect.orElseSucceed(() => ({})),
    )

  const writeAll = (secrets: Readonly<Record<string, string>>): Effect.Effect<void> =>
    PrivateFile.writePrivateAtomic(fs, path, filePath, JSON.stringify(secrets, null, 2)).pipe(Effect.orDie)

  const get = Effect.fn("AutomationSecretStore.get")((automationId: string) =>
    lock.withPermits(1)(readAll().pipe(Effect.map((secrets) => secrets[automationId]))),
  )

  const set = Effect.fn("AutomationSecretStore.set")((automationId: string, secret: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const secrets = yield* readAll()
        secrets[automationId] = secret
        yield* writeAll(secrets)
      }),
    ),
  )

  const remove = Effect.fn("AutomationSecretStore.remove")((automationId: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const secrets = yield* readAll()

        if (!(automationId in secrets)) return
        delete secrets[automationId]
        yield* writeAll(secrets)
      }),
    ),
  )

  return { get, set, remove }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/AutomationSecretStore") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [PlatformNode.fileSystem, PlatformNode.path, PlatformNode.layout],
})
