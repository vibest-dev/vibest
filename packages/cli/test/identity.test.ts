import { assert, describe, it } from "@effect/vitest"
import { HOST_ID_TIMEOUT, ioregUuid, loadIdentity, readHostId, shortHostName } from "@vibest/core/identity"
import { ID } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { runVibest, tempDirectory } from "@vibest/server/test/lib/fakes"
import { Duration, Effect, Fiber, FileSystem, Path } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

const host = (id: string | undefined, name = "mac-mini.local") => ({ name, id: Effect.succeed(id), pid: 4242 })

const IOREG = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x100000213, registered, matched, active, busy 0 (0 ms), retain 39>
    {
      "IOPlatformSerialNumber" = "XYZ"
      "IOPlatformUUID" = "CE07E143-6F61-59EE-8C81-950A88D74A2A"
    }
`

const fileIn = Effect.gen(function* () {
  const path = yield* Path.Path
  return path.join(yield* tempDirectory("vibest-identity-"), "identity.json")
})

const read = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.map((text) => JSON.parse(text) as { id: string; name: string; machine_id: string | null }),
  )

describe("identity.json", () => {
  it.effect("the first start writes a UUID, the short host name and the host id, and leaves no temp file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = yield* fileIn
      const first = yield* loadIdentity(file, host("HOST-A"))
      assert.match(first.identity.id, ID)
      assert.deepStrictEqual(yield* read(file), { id: first.identity.id, name: "mac-mini", machine_id: "HOST-A" })
      assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(file)), ["identity.json"])
      const again = yield* loadIdentity(file, host("HOST-A", "renamed"))
      assert.strictEqual(again.identity.id, first.identity.id)
      assert.strictEqual(again.identity.name, "mac-mini", "the name is fixed when the id is made")
      assert.isUndefined(again.warning)
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("another host id gives a new id, this host's name and the warning", () =>
    Effect.gen(function* () {
      const file = yield* fileIn
      const first = yield* loadIdentity(file, host("HOST-A"))
      const moved = yield* loadIdentity(file, host("HOST-B", "linux-box"))
      assert.notStrictEqual(moved.identity.id, first.identity.id)
      assert.strictEqual(moved.warning, "this home came from another machine: a new identity")
      assert.deepStrictEqual(yield* read(file), { id: moved.identity.id, name: "linux-box", machine_id: "HOST-B" })
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("no host id: the file is made with null; later a readable host id fills it in and keeps the id", () =>
    Effect.gen(function* () {
      const file = yield* fileIn
      const first = yield* loadIdentity(file, host(undefined))
      assert.strictEqual((yield* read(file)).machine_id, null)
      const kept = yield* loadIdentity(file, host(undefined))
      assert.strictEqual(kept.identity.id, first.identity.id)
      assert.strictEqual(kept.warning, "host id unreadable: identity kept")
      const filled = yield* loadIdentity(file, host("HOST-A"))
      assert.strictEqual(filled.identity.id, first.identity.id)
      assert.strictEqual((yield* read(file)).machine_id, "HOST-A")
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("an unreadable host id keeps a stored id that names another host", () =>
    Effect.gen(function* () {
      const file = yield* fileIn
      const first = yield* loadIdentity(file, host("HOST-A"))
      const kept = yield* loadIdentity(file, host(undefined))
      assert.strictEqual(kept.identity.id, first.identity.id)
      assert.strictEqual((yield* read(file)).machine_id, "HOST-A")
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("a file that does not parse, or has no valid id, is refused and left as it was", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      for (const text of ["{not json", JSON.stringify({ id: "nope", name: "x", machine_id: null })]) {
        const file = yield* fileIn
        yield* fs.writeFileString(file, text)
        const refused = yield* Effect.flip(loadIdentity(file, host("HOST-A")))
        assert.strictEqual(refused._tag, "IdentityUnreadable")
        assert.include(refused.message, `${file} is not a vibest identity file: move it aside and start again`)
        assert.strictEqual(yield* fs.readFileString(file), text)
      }
    }).pipe(Effect.provide(Platform.services)),
  )

  it.live("vibestd refuses to start on a malformed identity file and opens no database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout.make(yield* tempDirectory("vibest-home-"))
      yield* fs.writeFileString(layout.identity, "garbage")
      const run = yield* runVibest(
        layout.home,
        { HOME: layout.home, VIBEST_HOME: layout.home, PATH: "/usr/bin:/bin" },
        ["daemon", "--foreground"],
      )
      assert.strictEqual(run.code, 1)
      assert.include(yield* fs.readFileString(layout.log), "is not a vibest identity file")
      assert.isFalse(yield* fs.exists(layout.database))
      assert.strictEqual(yield* fs.readFileString(layout.identity), "garbage")
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})

describe("host id readers", () => {
  it.effect("ioreg output gives its IOPlatformUUID", () =>
    Effect.gen(function* () {
      assert.strictEqual(ioregUuid(IOREG), "CE07E143-6F61-59EE-8C81-950A88D74A2A")
      assert.strictEqual(yield* readHostId({ ioreg: Effect.succeed(IOREG), files: [] }), ioregUuid(IOREG))
      assert.isUndefined(yield* readHostId({ ioreg: Effect.succeed("nothing"), files: [] }))
      assert.isUndefined(yield* readHostId({ ioreg: Effect.fail(new Error("no ioreg")), files: [] }))
      assert.strictEqual(shortHostName("box.example.com"), "box")
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("machine-id files: the first line, the dbus fallback, and missing or empty files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* tempDirectory("vibest-machine-id-")
      const etc = path.join(dir, "etc-machine-id")
      const dbus = path.join(dir, "dbus-machine-id")
      assert.isUndefined(yield* readHostId({ files: [etc, dbus] }))
      yield* fs.writeFileString(dbus, "dbus-id\n")
      assert.strictEqual(yield* readHostId({ files: [etc, dbus] }), "dbus-id")
      yield* fs.writeFileString(etc, "\n")
      assert.strictEqual(yield* readHostId({ files: [etc, dbus] }), "dbus-id", "an empty file is skipped")
      yield* fs.writeFileString(etc, "etc-id\nmore\n")
      assert.strictEqual(yield* readHostId({ files: [etc, dbus] }), "etc-id")
      yield* fs.writeFileString(etc, "")
      yield* fs.writeFileString(dbus, "")
      assert.isUndefined(yield* readHostId({ files: [etc, dbus] }))
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("a reader slower than 2 s is unreadable", () =>
    Effect.gen(function* () {
      const slow = yield* Effect.forkChild(readHostId({ ioreg: Effect.never, files: [] }))
      yield* TestClock.adjust(Duration.sum(HOST_ID_TIMEOUT, Duration.millis(1)))
      assert.isUndefined(yield* Fiber.join(slow))
    }).pipe(Effect.provide(Platform.services)),
  )
})
