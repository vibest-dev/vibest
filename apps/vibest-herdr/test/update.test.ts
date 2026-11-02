// `vibest update` / `vibest upgrade` (SPEC §12.1): a real `vibest` process against a local registry, with a bun, an npm and a
// new vibest on PATH that only log their arguments.
import { assert, describe, it } from "@effect/vitest"
import http from "node:http"
import net from "node:net"
import * as Platform from "#platform"
import { Effect, FileSystem, Layer } from "effect"
import { compareVersions, installMethod, isSemver } from "../src/cli.ts"
import { layer as builtinHarnesses } from "@vibest/core/harnesses"
import { Layout } from "@vibest/core/paths"
import { PROTOCOL } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { runVibest, tempDirectory } from "./fakes.ts"

describe("vibest update", () => {
  it("compareVersions orders versions as semver does", () => {
    const ordered = ["0.0.1-alpha", "0.0.1-alpha.1", "0.0.1-alpha.beta", "0.0.1-beta", "0.0.1-beta.2", "0.0.1-beta.11", "0.0.1-rc.1", "0.0.1", "0.0.2", "0.1.0", "1.0.0", "10.0.0"]
    for (let i = 0; i < ordered.length; i++)
      for (let j = 0; j < ordered.length; j++) assert.strictEqual(Math.sign(compareVersions(ordered[i]!, ordered[j]!)), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`)
    assert.strictEqual(compareVersions("1.0.0+build.1", "1.0.0"), 0)
    for (const v of ["1.0.0", "0.0.1-beta.2", "1.0.0-rc.1+build.5"]) assert.isTrue(isSemver(v), v)
    for (const v of ["", "1.0", "v1.0.0", "1.0.0-", "1.0.0-beta..1", "latest"]) assert.isFalse(isSemver(v), v)
  })

  it("the install method comes from npm's launcher (VIBEST_HARNESSES) or install.sh's versions directory", () => {
    assert.deepStrictEqual(installMethod(["/usr/local/lib/node_modules/@vibest/cli-darwin-arm64/bin/vibest"], "/x/harnesses"), { kind: "npm" })
    assert.deepStrictEqual(installMethod(["/home/u/.local/share/vibest/versions/0.0.1-beta.6/bin/vibest"], undefined), { kind: "curl", share: "/home/u/.local/share/vibest" })
    // A build, or vibest from source, was installed by neither.
    for (const self of [["/repository/apps/vibest-herdr/dist/vibest"], ["/usr/bin/bun", "/repository/src/main.ts"], ["/s/versions/1/bin/vibest", "x"]])
      assert.isUndefined(installMethod(self, undefined), self.join(" "))
  })

  it.effect("the user's own vibest says once a day that a newer vibest is out; agents never see it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* tempDirectory("vibest-notice-")
      let hits = 0
      let latest = "999.0.0"
      const registry = yield* Effect.acquireRelease(
        Effect.callback<http.Server>((resume) => {
          const server = http.createServer((req, res) => {
            hits++
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: "@vibest/cli", version: latest }))
          })
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
        }),
        (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
      )
      const port = (registry.address() as { port: number }).port
      const run = (env: Record<string, string> = {}) =>
        runVibest(home, { HOME: home, VIBEST_HOME: `${home}/vibest`, VIBEST_HARNESSES: `${home}/harnesses`, npm_config_registry: `http://127.0.0.1:${port}`, ...env }, ["status"])
      const notice = `vibest 999.0.0 is available (this is ${VERSION}); update with: vibest update`
      assert.include((yield* run()).stderr, notice)
      // Within the day the cached answer stands: the registry is not asked again.
      latest = VERSION
      assert.include((yield* run()).stderr, notice)
      assert.strictEqual(hits, 1)
      assert.notInclude((yield* run({ VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234" })).stderr, "is available")
      assert.notInclude((yield* run({ VIBEST_NO_UPDATE_CHECK: "1" })).stderr, "is available")
      // A day later it asks again, and an up-to-date vibest says nothing.
      yield* fs.writeFileString(`${home}/vibest/update-check.json`, JSON.stringify({ checkedAt: 0, latest: "999.0.0" }))
      assert.notInclude((yield* run()).stderr, "is available")
      assert.strictEqual(hits, 2)
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(Platform.services, builtinHarnesses))), 60_000)

  it.effect("update (alias upgrade) asks the registry's beta tag, and installs a newer version with the package manager", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* tempDirectory("vibest-cli-")
      // A registry whose beta tag names `latest`.
      let latest = VERSION
      const registry = yield* Effect.acquireRelease(
        Effect.callback<http.Server>((resume) => {
          const server = http.createServer((req, res) => {
            if (req.url !== "/@vibest/cli/beta") return void res.writeHead(404).end()
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: "@vibest/cli", version: latest }))
          })
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
        }),
        (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
      )
      const port = (registry.address() as { port: number }).port
      yield* fs.makeDirectory(`${home}/bin`)
      // The bun, npm and newly installed vibest only log their arguments.
      for (const pm of ["bun", "npm", "vibest"]) {
        yield* fs.writeFileString(`${home}/bin/${pm}`, `#!/bin/sh\necho "${pm} $*" >> "${home}/pm.log"\n`)
        yield* fs.chmod(`${home}/bin/${pm}`, 0o755)
      }
      const run = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
        // VIBEST_HARNESSES: what npm's launcher sets, so this vibest counts as installed by npm.
        runVibest(home, { HOME: home, VIBEST_HOME: `${home}/vibest`, VIBEST_HARNESSES: `${home}/harnesses`, PATH: `${home}/bin:/bin:/usr/bin`, npm_config_registry: `http://127.0.0.1:${port}`, ...env }, args)

      const upToDate = `vibest is already up to date (v${VERSION}).\n`
      const same = yield* run(["upgrade"])
      assert.deepStrictEqual([same.code, same.stdout], [0, upToDate], same.stderr)
      // A registry behind this build (a local build ahead of the last release) is not an update either.
      latest = "0.0.0"
      assert.strictEqual((yield* run(["update"])).stdout, upToDate)
      // A registry answer that is not a semver version fails, and installs nothing.
      latest = "garbage"
      const bad = yield* run(["update"])
      assert.strictEqual(bad.code, 1)
      assert.match(bad.stderr, /^UpdateError: could not read .*: not a semver version: "garbage"/)
      latest = "999.0.0"
      const newer = yield* run(["update"])
      assert.strictEqual(newer.code, 0, newer.stderr)
      assert.include(newer.stdout, `vibest 999.0.0 is available (this is ${VERSION}).`)
      // The harness plugins come with the package: nothing else runs.
      assert.match(yield* fs.readFileString(`${home}/pm.log`), /^(bun add -g|npm install -g) @vibest\/cli@beta\n$/)

      // A running vibestd of another version (a stand-in that answers Ping and records what it is asked). Without a terminal
      // nothing is stopped, and update fails, saying what it installed and that vibestd still runs.
      const methods: Array<string> = []
      const socket = (yield* Layout.make(`${home}/vibest`)).socket
      yield* fs.makeDirectory(`${home}/vibest`, { recursive: true })
      yield* Effect.acquireRelease(
        Effect.callback<net.Server>((resume) => {
          const server = net.createServer((sock) =>
            sock.on("data", (chunk) => {
              for (const line of chunk.toString().split("\n").filter(Boolean)) {
                const req = JSON.parse(line) as { id?: unknown; method?: string }
                if (req.method) methods.push(req.method)
                if (req.method === "Ping")
                  sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { version: "0.0.0", protocol: PROTOCOL, instance: "old", runtimeSessions: [], runtimes: [] } }) + "\n")
              }
            }))
          server.listen(socket, () => resume(Effect.succeed(server)))
        }),
        (server) => Effect.sync(() => server.close()),
      )
      latest = VERSION
      const current = yield* run(["update"])
      assert.strictEqual(current.code, 1, current.stdout)
      assert.strictEqual(
        current.stderr,
        `vibestd not replaced: it still runs the vibest it was started with. replacing vibestd needs a yes on a terminal; nothing was stopped\nUpdateError: vibest ${VERSION} is current, but vibestd not replaced: it still runs the vibest it was started with\n`,
      )
      latest = "999.0.0"
      const installedOnly = yield* run(["update"])
      assert.strictEqual(installedOnly.code, 1, installedOnly.stdout)
      assert.match(installedOnly.stderr, new RegExp(`^vibestd not replaced: it still runs the vibest it was started with\\. .* --version\` reports ${VERSION.replaceAll(".", "\\.")}, not 999\\.0\\.0; vibestd was not stopped\n`))
      assert.match(installedOnly.stderr, /\nUpdateError: vibest 999\.0\.0 is installed, but vibestd not replaced: it still runs the vibest it was started with\n$/)
      assert.notInclude(methods, "Daemon.Stop")

      // The package manager failing stops the update: vibestd is not replaced.
      yield* fs.writeFileString(`${home}/bin/bun`, `#!/bin/sh\necho "bun $*" >> "${home}/pm.log"\nexit 1\n`)
      yield* fs.writeFileString(`${home}/bin/npm`, `#!/bin/sh\necho "npm $*" >> "${home}/pm.log"\nexit 1\n`)
      yield* fs.remove(`${home}/pm.log`)
      latest = "999.0.0"
      const pmFails = yield* run(["update"])
      assert.strictEqual(pmFails.code, 1, pmFails.stdout)
      assert.match(pmFails.stderr, /UpdateError: (bun add -g|npm install -g) @vibest\/cli@beta exited with 1; vibestd not attempted\n$/)
      assert.notInclude(pmFails.stderr, "not replaced")
      assert.notInclude(pmFails.stdout, "old version")

      // vibest from source was installed by neither npm nor install.sh: nothing is asked or installed.
      const source = yield* runVibest(home, { HOME: home, VIBEST_HOME: `${home}/vibest`, PATH: `${home}/bin:/bin:/usr/bin` }, ["update"])
      assert.strictEqual(source.code, 1)
      assert.match(source.stderr, /^UpdateError: this vibest \(.*\) was not installed by npm or install\.sh, so it cannot update itself/)

      // An agent may not update vibest.
      const agent = yield* runVibest(home, { HOME: home, VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234" }, ["update"])
      assert.match(agent.stderr, /^Forbidden: an agent may not run vibest update/)
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(Platform.services, builtinHarnesses))), 60_000)
})
