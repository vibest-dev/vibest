import { Json } from "@vibest/schema/json"
import { Mcp } from "@vibest/schema/mcp"
import { Effect, FileSystem, Option, Path, type Schema } from "effect"

import { json, vibest } from "../../../caller.ts"
import { Runtime } from "../../../framework/runtime.ts"
import { Commands } from "../../commands.ts"

export default Runtime.handler(Commands.commands.mcp.commands.exec, (o) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const directory = path.resolve(".")
    const filePath = Option.getOrUndefined(o.file)
    const inlineCode = Option.getOrUndefined(o.code)

    const code =
      filePath !== undefined
        ? yield* fs
            .readFileString(path.resolve(filePath))
            .pipe(
              Effect.mapError(
                (error) => new Mcp.ConfigError({ message: `Failed to read ${filePath}: ${error.message}` }),
              ),
            )
        : inlineCode

    if (code === undefined || code.trim().length === 0) {
      return yield* new Mcp.ConfigError({ message: "Provide JavaScript code or --file <script.js>" })
    }

    const rawInput = Option.getOrUndefined(o.input)
    let bindings: Schema.JsonObject | undefined

    if (rawInput !== undefined && rawInput.trim().length > 0) {
      const decoded = Json.parseJsonOption(rawInput)

      if (Option.isNone(decoded)) {
        return yield* new Mcp.ConfigError({ message: "Invalid --input JSON value" })
      }

      bindings = { input: decoded.value }
    }

    const timeoutMs = Option.getOrUndefined(o.timeout)
    const servers = o.server.length > 0 ? [...o.server] : undefined

    yield* vibest((client) =>
      client["server.codemode"]
        ["codemode.execute"]({
          payload: {
            code,
            directory,
            ...(servers !== undefined && { servers }),
            ...(bindings !== undefined && { bindings }),
            ...(timeoutMs !== undefined && { limits: { timeoutMs } }),
          },
        })
        .pipe(Effect.flatMap(json)),
    )
  }),
)
