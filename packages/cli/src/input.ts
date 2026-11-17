import { Effect, FileSystem, Path, Schema, Stdio, Stream } from "effect"

export class EmptyInput extends Schema.TaggedError<EmptyInput>()("EmptyInput", { message: Schema.String }) {}

export class FileInput extends Schema.TaggedError<FileInput>()("FileInput", { message: Schema.String }) {}

export const FILE_CAP = 10 * 1024 * 1024

export const input = (value: string, what: string) =>
  Effect.gen(function* () {
    const text = value === "-" ? yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin)) : value
    if (text.trim() === "") return yield* new EmptyInput({ message: `the ${what} is empty` })
    return text
  })

export const readAttachments = (files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* Effect.forEach(files, (file) =>
      Effect.gen(function* () {
        const resolved = path.resolve(file)
        const unreadable = (e: { readonly message: string }) =>
          new FileInput({ message: `cannot read --file ${file}: ${e.message}` })
        const info = yield* fs.stat(resolved).pipe(Effect.mapError(unreadable))
        if (info.type !== "File") return yield* new FileInput({ message: `--file ${file} is not a regular file` })
        if (Number(info.size) > FILE_CAP)
          return yield* new FileInput({ message: `--file ${file} is larger than 10 MiB` })
        return {
          name: path.basename(resolved),
          content: yield* fs.readFile(resolved).pipe(Effect.mapError(unreadable)),
        }
      }),
    )
  })
