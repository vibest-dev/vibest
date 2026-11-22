import { Plugin } from "@vibest/plugin/effect"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { Hex } from "effect/encoding"

import { type AgentFile, agentsFrom } from "./agent-file.ts"

interface Snapshot {
  readonly files: ReadonlyArray<AgentFile>
  readonly unreadable?: string
}

export const agentFilesPlugin = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const folder = path.join(home, "agents")
    let lastRead: ReadonlyArray<AgentFile> = []

    const readFiles = (names: ReadonlyArray<string>) =>
      Effect.forEach(names.filter((name) => name.endsWith(".md")).toSorted(), (name): Effect.Effect<AgentFile> => {
        const file = path.join(folder, name)

        return fs.readFileString(file).pipe(
          Effect.map((text) => ({ name, path: file, text })),
          Effect.orElseSucceed(() => ({ name, path: file, text: undefined })),
        )
      })

    const read: Effect.Effect<Snapshot> = fs.readDirectory(folder).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
      Effect.flatMap(readFiles),
      Effect.map((files): Snapshot => {
        lastRead = files

        return { files }
      }),
      Effect.catch((error) => Effect.succeed({ files: lastRead, unreadable: error.message })),
    )

    const pluginFor = (snapshot: Snapshot) =>
      Plugin.define({
        id: "vibest.agent-files",
        effect: (ctx) =>
          ctx.agent.transform((editor) => {
            if (snapshot.unreadable !== undefined)
              editor.invalid({ source: folder, error: `the folder cannot be read: ${snapshot.unreadable}` })
            const { definitions, invalid } = agentsFrom(snapshot.files)

            for (const definition of definitions) editor.add(definition)

            for (const agent of invalid) editor.invalid(agent)
          }),
      })

    const revise = Effect.gen(function* () {
      const snapshot = yield* read
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot)))

      return { revision: Hex.encode(digest).slice(0, 12), plugin: pluginFor(snapshot) }
    }).pipe(Effect.orElseSucceed(() => ({ revision: "unhashed", plugin: pluginFor({ files: lastRead }) })))

    return { plugin: pluginFor({ files: [] }), revise }
  })
