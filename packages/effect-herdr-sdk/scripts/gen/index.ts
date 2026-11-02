import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Path, Schema, Stdio } from "effect"

import { emitErrors } from "./emit-errors.js"
import { emitEvents } from "./emit-events.js"
import { emitParams } from "./emit-params.js"
import { emitResults } from "./emit-results.js"
import { header, loadSchema, packagePath } from "./schema.js"

/** The herdr release and protocol this SDK version is built against (schema/herdr-version.json). */
const Pin = Schema.fromJsonString(Schema.Struct({ version: Schema.String, protocol: Schema.Number }))

/** `bun run generate` writes src/generated; `bun run generate --check` fails if it is not what the schema produces. */
const main = Effect.gen(function* () {
  const check = (yield* (yield* Stdio.Stdio).args).includes("--check")
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const schema = yield* loadSchema
  const pin = yield* Schema.decodeUnknownEffect(Pin)(
    yield* fs.readFileString(yield* packagePath("schema", "herdr-version.json")),
  )
  if (schema.protocol !== pin.protocol)
    return yield* Effect.fail(
      new Error(`schema/herdr-api.schema.json is protocol ${schema.protocol}, herdr-version.json pins ${pin.protocol}`),
    )
  const h = header(schema)
  const outDir = yield* packagePath("src", "generated")
  yield* fs.makeDirectory(outDir, { recursive: true })

  const files: Record<string, string> = {
    "params.ts": emitParams(schema, h),
    "results.ts": emitResults(schema, h),
    "errors.ts": emitErrors(schema, h),
    "events.ts": emitEvents(schema, h),
    "index.ts": `${h}
// Each schema namespace is its own module: 12 type names (PaneInfo, TabInfo,
// WorkspaceInfo, ...) are defined DIFFERENTLY in the event and response
// namespaces, so a flat merge would be wrong, not just ambiguous.
export * as params from "./params.js";
export * as results from "./results.js";
export * as errors from "./errors.js";
export * as events from "./events.js";
// The handful of names everything needs, re-exported flat for convenience.
export type { Method, MethodParams, Subscription } from "./params.js";
export { METHODS } from "./params.js";
export type { ResponseResult, ResultByTag, ResultTag } from "./results.js";
export { METHOD_RESULT } from "./results.js";
export type { ErrorBody } from "./errors.js";
export type { EventFrame, SubscriptionEventFrame, PushFrame, AgentStatus, EventKind, SubscriptionEventKind } from "./events.js";
export const PROTOCOL = ${JSON.stringify(schema.protocol)} as const;
export const SCHEMA_VERSION = ${JSON.stringify(schema.schema_version)} as const;
`,
  }
  if (check) {
    const stale = yield* Effect.filter(Object.entries(files), ([name, body]) =>
      fs.readFileString(path.join(outDir, name)).pipe(
        Effect.map((disk) => disk !== body),
        Effect.orElseSucceed(() => true),
      ),
    )
    if (stale.length)
      return yield* Effect.fail(
        new Error(`src/generated is stale (${stale.map(([n]) => n).join(", ")}); run bun run generate`),
      )
    return yield* Console.log(`src/generated matches herdr ${pin.version} (protocol ${pin.protocol})`)
  }
  yield* Effect.forEach(Object.entries(files), ([name, body]) => fs.writeFileString(path.join(outDir, name), body), {
    discard: true,
  })
  yield* Console.log(
    `generated ${Object.keys(files).length} files → src/generated for herdr ${pin.version} (protocol ${pin.protocol})`,
  )
})

main.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
