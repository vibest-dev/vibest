import { assert, describe, it } from "@effect/vitest"
import { Harness } from "@vibest/core/harness"
import { pi } from "@vibest/plugin-harnesses"
import { VibestCommand } from "@vibest/schema/layout"
import { harnessesLayer } from "@vibest/testkit/fakes"
import * as Platform from "@vibest/testkit/platform"
import { ConfigProvider, Duration, Effect, Fiber, FileSystem, Layer, Path, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

const lister = (delay: (spawn: number) => Duration.Input) => {
  const spawned: Array<number> = []

  const spawner = ChildProcessSpawner.make(() => {
    const n = spawned.push(spawned.length)
    const lines = Stream.fromEffect(Effect.as(Effect.sleep(delay(n)), new TextEncoder().encode(`model-${n}\n`)))

    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(n),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: lines,
        stderr: Stream.empty,
        all: lines,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    )
  })

  const definition = {
    ...pi,
    checkProvider: () => undefined,
    models: {
      args: () => ["models"],
      answer: (seen: ReadonlyArray<string>) => (seen.length === 0 ? undefined : [{ model: seen[0]!, default: true }]),
    },
  }

  const layer = Harness.layer.pipe(
    Layer.provide(harnessesLayer([definition])),
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provide(Platform.services),
    Layer.provide(Layer.succeed(VibestCommand, ["vibest"])),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/nowhere", PATH: "" }))),
  )

  return { spawned, layer }
}

const names = (models: ReadonlyArray<{ readonly model: string }>) => models.map((m) => m.model)

describe("Harness.models keeps a model list per harness, provider and environment", () => {
  it.effect(
    "past its 5 minutes the list is served at once while one refresh lists again, shared by slow readers",
    () => {
      const fake = lister((n) => (n === 1 ? "0 millis" : "1 second"))

      return Effect.gen(function* () {
        const harness = yield* Harness.Service
        assert.deepStrictEqual(names(yield* harness.models("pi", null)), ["model-1"])
        yield* TestClock.adjust("5 minutes")

        const readers = yield* Effect.all(
          [1, 2, 3].map(() => harness.models("pi", null)),
          { concurrency: "unbounded" },
        )

        assert.deepStrictEqual(readers.map(names), [["model-1"], ["model-1"], ["model-1"]])
        yield* TestClock.adjust("1 millis")
        assert.strictEqual(fake.spawned.length, 2)
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(names(yield* harness.models("pi", null)), ["model-2"])
        assert.strictEqual(fake.spawned.length, 2)
      }).pipe(Effect.provide(fake.layer))
    },
  )

  it.effect("a 33rd environment evicts the oldest list: reading it again lists again and waits", () => {
    const fake = lister(() => "0 millis")

    return Effect.gen(function* () {
      const harness = yield* Harness.Service

      for (let job = 0; job <= 32; job++) yield* harness.models("pi", null, { JOB: String(job) })
      assert.strictEqual(fake.spawned.length, 33)
      const again = yield* Effect.forkChild(harness.models("pi", null, { JOB: "0" }))
      assert.deepStrictEqual(names(yield* Fiber.join(again)), ["model-34"])
      assert.strictEqual(fake.spawned.length, 34)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect(
    "a harness is available only through a file on PATH this user may execute, not a plain file, a directory or a file executable only by others",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-path-" })
        const binary = path.join(dir, pi.binary)

        const available = Effect.flatMap(Harness.Service, (harness) => harness.available("pi")).pipe(
          Effect.provide(
            Harness.layer.pipe(
              Layer.provide(harnessesLayer([pi])),
              Layer.provide(Platform.services),
              Layer.provide(Layer.succeed(VibestCommand, ["vibest"])),
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/nowhere", PATH: dir }))),
            ),
          ),
        )

        yield* fs.makeDirectory(binary)
        assert.isFalse(yield* available)
        yield* fs.remove(binary, { recursive: true })
        yield* fs.writeFileString(binary, "#!/bin/sh\n")
        yield* fs.chmod(binary, 0o644)
        assert.isFalse(yield* available)
        yield* fs.chmod(binary, 0o645)
        assert.isFalse(yield* available)
        yield* fs.chmod(binary, 0o755)
        assert.isTrue(yield* available)
      }).pipe(Effect.provide(Platform.services)),
  )
})
