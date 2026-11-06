import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Path, Schema, Stdio } from "effect"

import { emitApi, type OpenRpc } from "./emit.ts"

const VersionPin = Schema.fromJsonString(Schema.Struct({ version: Schema.String, generation: Schema.Number }))
const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Any)))

const GENERATION_IN_DESCRIPTION = /Protocol generation (\d+)\./

const main = Effect.gen(function* () {
  const check = (yield* (yield* Stdio.Stdio).args).includes("--check")
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "..", "..")
  const doc = (yield* decodeDocument(
    yield* fs.readFileString(path.join(root, "schema", "hc-openrpc.json")),
  )) as unknown as OpenRpc
  const pin = yield* Schema.decodeUnknownEffect(VersionPin)(
    yield* fs.readFileString(path.join(root, "schema", "hc-version.json")),
  )
  const generation = Number(GENERATION_IN_DESCRIPTION.exec(doc.info.description)?.[1])
  if (doc.info.version !== pin.version || generation !== pin.generation)
    return yield* Effect.fail(
      new Error(
        `schema/hc-openrpc.json is hc ${doc.info.version} generation ${generation}, hc-version.json pins ${pin.version} generation ${pin.generation}`,
      ),
    )
  const target = path.join(root, "src", "generated", "api.ts")
  const body = emitApi(doc, pin.generation)
  if (check) {
    const disk = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => ""))
    if (disk !== body) return yield* Effect.fail(new Error("src/generated/api.ts is stale; run bun run generate"))
    return yield* Console.log(`src/generated matches hc ${pin.version} (generation ${pin.generation})`)
  }
  yield* fs.makeDirectory(path.dirname(target), { recursive: true })
  yield* fs.writeFileString(target, body)
  yield* Console.log(`generated src/generated/api.ts for hc ${pin.version} (generation ${pin.generation})`)
})

main.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
