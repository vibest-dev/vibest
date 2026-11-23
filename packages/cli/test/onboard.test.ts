import fs from "node:fs"
import http from "node:http"
import type net from "node:net"
import os from "node:os"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { Layout } from "@vibest/schema/layout"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema, Sink, Stdio, Stream } from "effect"

import * as Platform from "#platform"

import { askChoice } from "../src/ask.ts"
import { chooseHarness, chooseRuntime } from "../src/onboard.ts"

const FAKE_INSTALL_SH = `#!/bin/sh
set -eu
[ "$HC_VERSION" = 0.1.22 ] || { echo "wrong HC_VERSION $HC_VERSION" >&2; exit 3; }
mkdir -p "$HC_INSTALL_DIR"
cat > "$HC_INSTALL_DIR/herdr-core" <<'EOF'
#!/bin/sh
[ "$1 $2" = "server start" ] && : > "$(dirname "$0")/started"
EOF
chmod 755 "$HC_INSTALL_DIR/herdr-core"
ln -s herdr-core "$HC_INSTALL_DIR/hc"
`

const decodeSaved = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))

const typed = (...answers: ReadonlyArray<string>) => {
  const left = [...answers]

  return Effect.succeed(
    Stream.suspend(() => {
      const line = left.shift()

      return line === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(`${line}\n`))
    }),
  )
}

const world = (o: {
  readonly terminal: boolean
  readonly stdin: Stream.Stream<Uint8Array>
  readonly releases?: string
  readonly home?: string
}) => {
  const home = o.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "vibest-onboard-"))
  const bin = path.join(home, ".local", "bin")

  const layer = Layer.mergeAll(
    Stdio.layerTest({
      stdinIsTerminal: Effect.succeed(o.terminal),
      stdoutIsTerminal: Effect.succeed(o.terminal),
      stdin: o.stdin,
      stdout: () => Sink.drain,
    }),
    Layer.effect(Layout, Layout.make(path.join(home, ".vibest"))),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        HOME: home,
        PATH: "/usr/bin:/bin",
        ...(o.releases !== undefined && { HERDR_RELEASES_URL: o.releases }),
      }),
    ),
  ).pipe(Layer.provideMerge(Platform.services))

  const config = path.join(home, ".vibest", "vibest.json")

  return {
    home,
    bin,
    config,
    layer,
    saved: () => decodeSaved(fs.readFileSync(config, "utf8")),
  }
}

type Client = Parameters<typeof chooseRuntime<never>>[0]

const fakeClient = (o: {
  readonly runtimes?: () => ReadonlyArray<{ readonly kind: string; readonly status: string }>
  readonly harnesses?: ReadonlyArray<string>
}): Client => ({
  "Runtimes.Doctor": () =>
    Effect.sync(() => (o.runtimes?.() ?? []).map((row) => ({ ...row, name: row.kind, checks: [] }))),
  "Harnesses.List": () =>
    Effect.succeed((o.harnesses ?? []).map((harness) => ({ harness, binary: harness, problem: null, models: [] }))),
})

const runtimes = (rows: () => ReadonlyArray<{ readonly kind: string; readonly status: string }>) =>
  fakeClient({ runtimes: rows })

const serveInstaller = Effect.acquireRelease(
  Effect.callback<http.Server>((resume) => {
    const server = http.createServer((request, response) => {
      if (request.url !== "/core/install.sh") return void response.writeHead(404).end()
      response.writeHead(200, { "content-type": "text/plain" }).end(FAKE_INSTALL_SH)
    })

    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
  }),
  (server) => Effect.sync(() => server.close()),
).pipe(
  Effect.map((server) => {
    const address = server.address()

    return `http://127.0.0.1:${(address as net.AddressInfo).port}/`
  }),
)

describe("onboarding in a plain terminal", () => {
  it.live("no runtime: y installs herdr-core from HERDR_RELEASES_URL, starts it and saves hc", () =>
    Effect.gen(function* () {
      const releases = yield* serveInstaller
      const w = world({ terminal: true, stdin: yield* typed("y"), releases })
      const started = path.join(w.bin, "started")

      const client = runtimes(() => [{ kind: "hc", status: fs.existsSync(started) ? "online" : "offline" }])

      const chosen = yield* chooseRuntime(client, { reuse: true, saveWithoutAsking: false }).pipe(
        Effect.provide(w.layer),
      )

      assert.strictEqual(chosen, "hc")
      assert.isTrue(fs.existsSync(started), "hc server start ran")
      assert.isTrue(fs.existsSync(path.join(w.bin, "hc")))
      assert.strictEqual(w.saved()["defaultRuntime"], "hc")
    }).pipe(Effect.scoped),
  )

  it.live("no runtime: anything but y installs nothing and fails naming how to install one", () =>
    Effect.gen(function* () {
      const w = world({ terminal: true, stdin: yield* typed("") })
      const client = runtimes(() => [{ kind: "hc", status: "offline" }])

      const exit = yield* Effect.exit(
        chooseRuntime(client, { reuse: true, saveWithoutAsking: false }).pipe(Effect.provide(w.layer)),
      )

      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(exit), "releases.herdr.dev/core/install.sh")
      assert.isFalse(fs.existsSync(w.bin))
      assert.isFalse(fs.existsSync(w.config))
    }),
  )

  it.live("two runtimes: the numbered pick is saved beside the other keys and reused without asking", () =>
    Effect.gen(function* () {
      const w = world({ terminal: true, stdin: yield* typed("2", "") })
      fs.mkdirSync(path.dirname(w.config), { recursive: true })
      fs.writeFileSync(w.config, JSON.stringify({ plugins: ["-vibest.idle-stop"], cloneDirectory: "~/src" }))

      const client = runtimes(() => [
        { kind: "herdr", status: "online" },
        { kind: "rex", status: "online" },
        { kind: "hc", status: "online" },
      ])

      const first = yield* chooseRuntime(client, { reuse: true, saveWithoutAsking: false }).pipe(
        Effect.provide(w.layer),
      )

      assert.strictEqual(first, "rex")
      assert.deepStrictEqual(w.saved(), {
        plugins: ["-vibest.idle-stop"],
        cloneDirectory: "~/src",
        defaultRuntime: "rex",
      })

      const again = world({ terminal: true, stdin: Stream.empty, home: w.home })

      const reused = yield* chooseRuntime(client, { reuse: true, saveWithoutAsking: false }).pipe(
        Effect.provide(again.layer),
      )

      assert.strictEqual(reused, "rex")
    }),
  )

  it.live("not a terminal and no saved runtime: asks nothing and chooses nothing", () =>
    Effect.gen(function* () {
      const w = world({ terminal: false, stdin: Stream.never })

      const client = runtimes(() => [
        { kind: "hc", status: "online" },
        { kind: "rex", status: "online" },
      ])

      const chosen = yield* chooseRuntime(client, { reuse: true, saveWithoutAsking: false }).pipe(
        Effect.provide(w.layer),
      )

      assert.isUndefined(chosen)
      assert.isFalse(fs.existsSync(w.config))
    }),
  )

  it.live("vibest onboard's steps save the runtime and the coding agent without asking to save", () =>
    Effect.gen(function* () {
      const w = world({ terminal: true, stdin: yield* typed("", "2") })
      const online = runtimes(() => [{ kind: "hc", status: "online" }])

      const runtime = yield* chooseRuntime(online, { reuse: false, saveWithoutAsking: true }).pipe(
        Effect.provide(w.layer),
      )

      const harness = yield* chooseHarness(fakeClient({ harnesses: ["claude", "pi"] }), {
        saveWithoutAsking: true,
      }).pipe(Effect.provide(w.layer))

      assert.strictEqual(runtime, "hc")
      assert.strictEqual(harness, "claude")
      assert.deepStrictEqual(w.saved(), { defaultRuntime: "hc", defaultHarness: "claude" })
    }),
  )

  it.live("a choice re-asks on an answer out of range and takes Enter as the first", () =>
    Effect.gen(function* () {
      const w = world({ terminal: true, stdin: yield* typed("9", "x", "2") })
      const picked = yield* askChoice("Pick", ["a", "b"]).pipe(Effect.provide(w.layer))

      assert.strictEqual(Option.getOrUndefined(picked), 1)
    }),
  )
})
