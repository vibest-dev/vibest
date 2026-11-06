import { assert, it } from "@effect/vitest"
import { writeTerminalStatus } from "@vibest/core/results"
import { Effect, FileSystem, PlatformError } from "effect"

const failure = PlatformError.systemError({
  module: "FileSystem",
  method: "open",
  _tag: "NotFound",
  pathOrDescriptor: "/dev/tty",
})

const tty = (fail?: "open" | "write") => {
  const writes: Array<Uint8Array> = []
  let closed = 0
  const unused = Effect.die("unexpected file operation")
  const file: FileSystem.File = {
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: unused,
    seek: () => unused,
    sync: unused,
    read: () => unused,
    readAlloc: () => unused,
    truncate: () => unused,
    writeAll: () => unused,
    write: (bytes) =>
      Effect.sync(() => writes.push(bytes)).pipe(
        Effect.andThen(fail === "write" ? Effect.fail(failure) : Effect.succeed(bytes.length)),
      ),
  }
  const fs = FileSystem.makeNoop({
    open: (path, options) => {
      assert.strictEqual(path, "/dev/tty")
      assert.deepStrictEqual(options, { flag: "w" })
      return fail === "open"
        ? Effect.fail(failure)
        : Effect.acquireRelease(Effect.succeed(file), () =>
            Effect.sync(() => {
              closed++
            }),
          )
    },
  })
  return { fs, writes, closed: () => closed }
}

it.effect("writes one exact OSC 7501 record to the tty and closes it", () =>
  Effect.gen(function* () {
    const t = tty()
    const run = (...args: Parameters<typeof writeTerminalStatus>) =>
      writeTerminalStatus(...args).pipe(Effect.provideService(FileSystem.FileSystem, t.fs))
    yield* run("working")
    yield* run("idle")
    yield* run("blocked")
    for (const kind of ["permission", "question", "auth"] as const) yield* run("blocked", kind)
    const bytes = [
      "state=working",
      "state=idle",
      "state=blocked",
      "state=blocked:kind=permission",
      "state=blocked:kind=question",
      "state=blocked:kind=auth",
    ].map((body) => new TextEncoder().encode("\x1b]7501;" + body + "\x1b\\"))
    assert.deepStrictEqual(t.writes, bytes)
    assert.strictEqual(t.closed(), 6)
  }),
)

it.effect("no controlling tty or a failed write never fails the hook; an opened handle still closes", () =>
  Effect.gen(function* () {
    for (const fail of ["open", "write"] as const) {
      const t = tty(fail)
      yield* writeTerminalStatus("working").pipe(Effect.provideService(FileSystem.FileSystem, t.fs))
      assert.strictEqual(t.closed(), fail === "open" ? 0 : 1)
    }
  }),
)

it("a blocked kind cannot be attached to a working or idle record", () => {
  // @ts-expect-error only blocked accepts a kind
  writeTerminalStatus("working", "permission")
  // @ts-expect-error only blocked accepts a kind
  writeTerminalStatus("idle", "question")
})
