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

const notText = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return true
  if (bytes.length === 0) return false
  let controls = 0
  for (const byte of bytes) if (byte < 9 || (byte > 13 && byte < 32)) controls++
  if (controls / bytes.length > 0.3) return true
  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(bytes)
    const encoded = new TextEncoder().encode(text)
    return encoded.byteLength !== bytes.byteLength || encoded.some((byte, i) => byte !== bytes[i])
  } catch {
    return true
  }
}

export const attachFiles = (prompt: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (files.length === 0) return prompt
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const blocks: Array<string> = []
    for (const file of files) {
      const resolved = path.resolve(file)
      const info = yield* fs
        .stat(resolved)
        .pipe(Effect.mapError((e) => new FileInput({ message: `cannot read --file ${file}: ${e.message}` })))
      if (info.type !== "File") return yield* new FileInput({ message: `--file ${file} is not a text file` })
      if (Number(info.size) > FILE_CAP) return yield* new FileInput({ message: `--file ${file} is larger than 10 MiB` })
      const bytes = yield* fs
        .readFile(resolved)
        .pipe(Effect.mapError((e) => new FileInput({ message: `cannot read --file ${file}: ${e.message}` })))
      if (notText(bytes)) return yield* new FileInput({ message: `--file ${file} is not text` })
      blocks.push(`File: ${resolved}\n\n${new TextDecoder().decode(bytes)}`)
    }
    const attached = blocks.join("\n\n")
    return prompt.endsWith("\n") ? `${prompt}\n${attached}` : `${prompt}\n\n${attached}`
  })
