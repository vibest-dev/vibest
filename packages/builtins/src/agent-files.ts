import { Plugin } from "@vibest/plugin/effect"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { Hex } from "effect/encoding"

import { type AgentFile, agentsFrom } from "./agent-file.ts"
import { coordinator, general } from "./agent.ts"

export const agentFilesPlugin = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const folder = path.join(home, "agents")

    const read = fs.readDirectory(folder).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
      Effect.flatMap((names) =>
        Effect.forEach(names.filter((name) => name.endsWith(".md")).toSorted(), (name): Effect.Effect<AgentFile> => {
          const file = path.join(folder, name)

          return fs.readFileString(file).pipe(
            Effect.map((text) => ({ name, path: file, text })),
            Effect.orElseSucceed(() => ({ name, path: file, text: undefined })),
          )
        }),
      ),
    )

    const revision = read.pipe(
      Effect.flatMap((files) => crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify(files)))),
      Effect.map((digest) => Hex.encode(digest).slice(0, 12)),
      Effect.orElseSucceed(() => "unreadable"),
    )

    const plugin = Plugin.define({
      id: "vibest.agent-files",
      effect: (ctx) =>
        Effect.gen(function* () {
          const { definitions, invalid } = agentsFrom(yield* read, [coordinator, general])
          yield* ctx.agent.transform((editor) => {
            for (const definition of definitions) editor.add(definition)

            for (const agent of invalid) editor.invalid(agent)
          })
        }),
    })

    return { plugin, revision }
  })
