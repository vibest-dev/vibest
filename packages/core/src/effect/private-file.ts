import { Effect, type FileSystem, type Path } from "effect"

export * as PrivateFile from "./private-file.ts"

const randomSuffix = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export const writeAtomic = (fs: FileSystem.FileSystem, path: Path.Path, filePath: string, content: string) =>
  Effect.gen(function* () {
    const dir = path.dirname(filePath)
    yield* fs.makeDirectory(dir, { recursive: true })
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomSuffix()}.tmp`)

    yield* fs.writeFileString(tmpPath, content).pipe(
      Effect.andThen(fs.rename(tmpPath, filePath)),
      Effect.onError(() => fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)),
    )
  })

export const writePrivateAtomic = (fs: FileSystem.FileSystem, path: Path.Path, filePath: string, content: string) =>
  Effect.gen(function* () {
    const dir = path.dirname(filePath)
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
    yield* fs.chmod(dir, 0o700).pipe(Effect.ignore)
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomSuffix()}.tmp`)

    yield* fs.writeFileString(tmpPath, content, { mode: 0o600 }).pipe(
      Effect.andThen(fs.chmod(tmpPath, 0o600).pipe(Effect.ignore)),
      Effect.andThen(fs.rename(tmpPath, filePath)),
      Effect.onError(() => fs.remove(tmpPath, { force: true }).pipe(Effect.ignore)),
    )
  })
