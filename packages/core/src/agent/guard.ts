import type * as VibestPlugin from "@vibest/plugin/effect"
import { Config, Effect, Option, Path, Predicate, Schema } from "effect"

import { Plugins } from "../plugin.ts"

export const toolPath = (raw: string, base: string, home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    let p = raw

    if (p.startsWith("file://")) {
      const fromUrl = yield* Effect.try(() => new URL(p)).pipe(Effect.flatMap(path.fromFileUrl), Effect.option)

      if (Option.isNone(fromUrl) || fromUrl.value === "") return undefined
      p = fromUrl.value
    }

    p = p.replace(/^~(?=$|\/)/, home)

    return path.isAbsolute(p) ? p : `${base}${path.sep}${p}`
  })

const decodePreToolUse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      tool_name: Schema.String,
      tool_input: Schema.Record(Schema.String, Schema.Json),
      cwd: Schema.optional(Schema.String),
      workspace_roots: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
)

export const check = Effect.fn("Guard.check")(function* (
  session: VibestPlugin.SessionToolExecuteBefore["session"],
  raw: string,
) {
  const input = yield* decodePreToolUse(raw)
  const path = yield* Path.Path
  const roots = input.workspace_roots ?? []
  const base = input.cwd || (roots.length === 1 ? roots[0] : undefined)

  if (!base || !path.isAbsolute(base))
    return yield* Effect.fail(new Error("the hook input has no absolute working directory"))
  const own = input.tool_input.cwd

  if (own !== undefined && !Predicate.isString(own))
    return yield* Effect.fail(new Error("tool_input.cwd is not a string"))
  const ownPath = own ? yield* toolPath(own, base, yield* Config.String("HOME")) : base

  if (ownPath === undefined) return yield* Effect.fail(new Error("tool_input.cwd is a file URL vibest cannot read"))
  const plugins = yield* Plugins.Service

  return yield* plugins.guard({
    session,
    tool: input.tool_name,
    input: input.tool_input,
    cwd: path.normalize(ownPath),
  })
})
