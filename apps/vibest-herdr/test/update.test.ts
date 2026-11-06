import http from "node:http"
import net from "node:net"

import { assert, describe, it } from "@effect/vitest"
import { layer as builtinHarnesses } from "@vibest/core/harnesses"
import { Layout } from "@vibest/core/paths"
import { PROTOCOL } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { Effect, FileSystem, Layer } from "effect"

import * as Platform from "#platform"

import { compareVersions, installMethod, isSemver, removeCommand, stageCommand, upgradeCommand } from "../src/cli.ts"
import { runVibest, tempDirectory } from "./fakes.ts"

describe("vibest update", () => {
  it("compareVersions orders versions as semver does", () => {
    const ordered = [
      "0.0.1-alpha",
      "0.0.1-alpha.1",
      "0.0.1-alpha.beta",
      "0.0.1-beta",
      "0.0.1-beta.2",
      "0.0.1-beta.11",
      "0.0.1-rc.1",
      "0.0.1",
      "0.0.2",
      "0.1.0",
      "1.0.0",
      "10.0.0",
    ]
    for (let i = 0; i < ordered.length; i++)
      for (let j = 0; j < ordered.length; j++)
        assert.strictEqual(
          Math.sign(compareVersions(ordered[i]!, ordered[j]!)),
          Math.sign(i - j),
          `${ordered[i]} vs ${ordered[j]}`,
        )
    assert.strictEqual(compareVersions("1.0.0+build.1", "1.0.0"), 0)
    for (const v of ["1.0.0", "0.0.1-beta.2", "1.0.0-rc.1+build.5"]) assert.isTrue(isSemver(v), v)
    for (const v of ["", "1.0", "v1.0.0", "1.0.0-", "1.0.0-beta..1", "latest"]) assert.isFalse(isSemver(v), v)
  })

  it("the install method comes from npm's launcher (VIBEST_HARNESSES) or install.sh's versions directory", () => {
    assert.deepStrictEqual(
      installMethod(["/usr/local/lib/node_modules/@vibest/cli-darwin-arm64/bin/vibest"], "/x/harnesses"),
      { kind: "npm" },
    )
    assert.deepStrictEqual(installMethod(["/home/u/.local/share/vibest/versions/0.0.1-beta.6/bin/vibest"], undefined), {
      kind: "curl",
      share: "/home/u/.local/share/vibest",
    })
    for (const argv of [
      ["/repository/apps/vibest-herdr/dist/vibest"],
      ["/usr/bin/bun", "/repository/src/main.ts"],
      ["/s/versions/1/bin/vibest", "x"],
    ])
      assert.isUndefined(installMethod(argv, undefined), argv.join(" "))
  })

  it("update and removal go to the package manager that owns the binary, from its real path", () => {
    const bun = "/home/u/.bun/install/global/node_modules/@vibest/cli-darwin-arm64/bin/vibest"
    const fnm =
      "/home/u/.local/state/fnm_multishells/1/lib/node_modules/@vibest/cli/node_modules/@vibest/cli-darwin-arm64/bin/vibest"
    assert.deepStrictEqual(upgradeCommand(bun, "2.0.0", "darwin-arm64"), [
      "bun",
      "add",
      "-g",
      "@vibest/cli@2.0.0",
      "@vibest/cli-darwin-arm64@2.0.0",
    ])
    assert.deepStrictEqual(upgradeCommand(fnm, "2.0.0"), [
      "/home/u/.local/state/fnm_multishells/1/bin/npm",
      "install",
      "-g",
      "--prefix",
      "/home/u/.local/state/fnm_multishells/1",
      "@vibest/cli@2.0.0",
    ])
    assert.deepStrictEqual(
      upgradeCommand("/x/node_modules/@vibest/cli-linux-x64/bin/vibest", "2.0.0"),
      ["npm", "install", "-g", "@vibest/cli@2.0.0"],
      "a local npm install, neither as far as the path shows: the npm on PATH",
    )
    assert.deepStrictEqual(
      stageCommand(bun, "/t", "2.0.0", "darwin-arm64"),
      ["bun", "add", "--cwd", "/t", "@vibest/cli@2.0.0", "@vibest/cli-darwin-arm64@2.0.0"],
      "the version to try first goes to a directory of its own, not the global install",
    )
    assert.deepStrictEqual(stageCommand(fnm, "/t", "2.0.0"), [
      "/home/u/.local/state/fnm_multishells/1/bin/npm",
      "install",
      "--prefix",
      "/t",
      "@vibest/cli@2.0.0",
    ])
    assert.strictEqual(
      removeCommand("/home/u/.bun/bin/vibest", "/home/u/.bun/install/global/node_modules/@vibest/cli/bin/vibest.cjs"),
      "bun remove -g @vibest/cli",
    )
    assert.strictEqual(
      removeCommand("/opt/homebrew/bin/vibest", "/opt/homebrew/lib/node_modules/@vibest/cli/bin/vibest.cjs"),
      "/opt/homebrew/bin/npm uninstall -g --prefix /opt/homebrew @vibest/cli",
    )
    assert.strictEqual(
      removeCommand("/home/u/.local/bin/vibest", "/home/u/.local/share/vibest/versions/1.0.0/bin/vibest"),
      "rm /home/u/.local/bin/vibest",
    )
  })

  it.effect(
    "the user's own vibest says once a day that a newer vibest is out; agents never see it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* tempDirectory("vibest-notice-")
        let hits = 0
        let latest = "999.0.0"
        const registry = yield* Effect.acquireRelease(
          Effect.callback<http.Server>((resume) => {
            const server = http.createServer((req, res) => {
              hits++
              res
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify({ name: "@vibest/cli", version: latest }))
            })
            server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
          }),
          (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
        )
        const port = (registry.address() as { port: number }).port
        const run = (env: Record<string, string> = {}) =>
          runVibest(
            home,
            {
              HOME: home,
              VIBEST_HOME: `${home}/vibest`,
              VIBEST_HARNESSES: `${home}/harnesses`,
              npm_config_registry: `http://127.0.0.1:${port}`,
              ...env,
            },
            ["status"],
          )
        const notice = `vibest 999.0.0 is available (this is ${VERSION}); update with: vibest update`
        assert.include((yield* run()).stderr, notice)
        latest = VERSION
        assert.include((yield* run()).stderr, notice)
        assert.strictEqual(hits, 1, "within the day the cached answer stands")
        assert.notInclude(
          (yield* run({ VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" })).stderr,
          "is available",
        )
        assert.notInclude((yield* run({ VIBEST_NO_UPDATE_CHECK: "1" })).stderr, "is available")
        yield* fs.writeFileString(
          `${home}/vibest/update-check.json`,
          JSON.stringify({ checkedAt: 0, latest: "999.0.0" }),
        )
        assert.notInclude((yield* run()).stderr, "is available")
        assert.strictEqual(hits, 2, "a day later it asks again, and an up-to-date vibest says nothing")
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(Platform.services, builtinHarnesses))),
    60_000,
  )

  it.effect(
    "update (alias upgrade) asks the registry's beta tag, and installs a newer version with the package manager",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* tempDirectory("vibest-cli-")
        let latest = VERSION
        const registry = yield* Effect.acquireRelease(
          Effect.callback<http.Server>((resume) => {
            const server = http.createServer((req, res) => {
              if (req.url !== "/@vibest/cli/beta") return void res.writeHead(404).end()
              res
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify({ name: "@vibest/cli", version: latest }))
            })
            server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
          }),
          (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
        )
        const port = (registry.address() as { port: number }).port
        yield* fs.makeDirectory(`${home}/bin`)
        const stagesATriedVersion = `case "$2" in --prefix|--cwd) mkdir -p "$3/node_modules/.bin" && printf '#!/bin/sh\\necho vibest v999.0.0\\n' > "$3/node_modules/.bin/vibest" && chmod +x "$3/node_modules/.bin/vibest" ;; esac\n`
        for (const stub of ["bun", "npm", "vibest"]) {
          yield* fs.writeFileString(
            `${home}/bin/${stub}`,
            `#!/bin/sh\necho "${stub} $*" >> "${home}/pm.log"\n${stub === "vibest" ? "" : stagesATriedVersion}`,
          )
          yield* fs.chmod(`${home}/bin/${stub}`, 0o755)
        }
        const npmLauncherEnv = { VIBEST_HARNESSES: `${home}/harnesses` }
        const run = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
          runVibest(
            home,
            {
              HOME: home,
              VIBEST_HOME: `${home}/vibest`,
              ...npmLauncherEnv,
              PATH: `${home}/bin:/bin:/usr/bin`,
              npm_config_registry: `http://127.0.0.1:${port}`,
              ...env,
            },
            args,
          )

        const upToDate = `vibest is already up to date (v${VERSION}).\n`
        const same = yield* run(["upgrade"])
        assert.deepStrictEqual([same.code, same.stdout], [0, upToDate], same.stderr)
        latest = "0.0.0"
        assert.strictEqual(
          (yield* run(["update"])).stdout,
          upToDate,
          "a registry behind this build (a local build ahead of the last release) is not an update either",
        )
        latest = "garbage"
        const bad = yield* run(["update"])
        assert.strictEqual(bad.code, 1)
        assert.match(bad.stderr, /^UpdateError: could not read .*: not a semver version: "garbage"/)
        latest = "999.0.0"
        const newer = yield* run(["update"])
        assert.strictEqual(newer.code, 0, newer.stderr)
        assert.include(newer.stdout, `vibest 999.0.0 is available (this is ${VERSION}).`)
        assert.match(
          yield* fs.readFileString(`${home}/pm.log`),
          /^(bun add --cwd \S+ @vibest\/cli@999\.0\.0 \S+|npm install --prefix \S+ @vibest\/cli@999\.0\.0)\n(bun add -g|npm install -g) @vibest\/cli@999\.0\.0\n$/,
          "the version is tried in a directory of its own first, then installed; the harness plugins come with the package: nothing else runs",
        )

        const askedMethods: Array<string> = []
        const socket = (yield* Layout.make(`${home}/vibest`)).socket
        yield* fs.makeDirectory(`${home}/vibest`, { recursive: true })
        yield* Effect.acquireRelease(
          Effect.callback<net.Server>((resume) => {
            const server = net.createServer((sock) =>
              sock.on("data", (chunk) => {
                for (const line of chunk.toString().split("\n").filter(Boolean)) {
                  const req = JSON.parse(line) as { id?: unknown; method?: string }
                  if (req.method) askedMethods.push(req.method)
                  if (req.method === "Ping")
                    sock.write(
                      JSON.stringify({
                        jsonrpc: "2.0",
                        id: req.id,
                        result: {
                          version: "0.0.0",
                          protocol: PROTOCOL,
                          instance: "old",
                          runtimeSessions: [],
                          runtimes: [],
                        },
                      }) + "\n",
                    )
                }
              }),
            )
            server.listen(socket, () => resume(Effect.succeed(server)))
          }),
          (server) => Effect.sync(() => server.close()),
        )
        latest = VERSION
        const current = yield* run(["update"])
        assert.strictEqual(current.code, 1, current.stdout)
        assert.strictEqual(
          current.stderr,
          `vibestd not replaced: it still runs the vibest it was started with. replacing vibestd needs a yes on a terminal; nothing was stopped\nUpdateError: vibest ${VERSION}: vibestd not replaced: it still runs the vibest it was started with\n`,
        )
        latest = "999.0.0"
        const installedOnly = yield* run(["update"])
        assert.strictEqual(installedOnly.code, 1, installedOnly.stdout)
        assert.match(
          installedOnly.stderr,
          new RegExp(
            `^vibestd not replaced: it still runs the vibest it was started with\\. .* --version\` reports ${VERSION.replaceAll(".", "\\.")}, not 999\\.0\\.0; vibestd was not stopped\n`,
          ),
        )
        assert.match(
          installedOnly.stderr,
          /\nUpdateError: vibest 999\.0\.0: vibestd not replaced: it still runs the vibest it was started with\. To go back to vibest \S+ instead: (bun add -g|npm install -g) @vibest\/cli@\S+\n$/,
        )
        assert.notInclude(askedMethods, "Daemon.Stop", "without a terminal nothing is stopped")

        yield* fs.writeFileString(`${home}/bin/bun`, `#!/bin/sh\necho "bun $*" >> "${home}/pm.log"\nexit 1\n`)
        yield* fs.writeFileString(`${home}/bin/npm`, `#!/bin/sh\necho "npm $*" >> "${home}/pm.log"\nexit 1\n`)
        yield* fs.remove(`${home}/pm.log`)
        latest = "999.0.0"
        const pmFails = yield* run(["update"])
        assert.strictEqual(pmFails.code, 1, pmFails.stdout)
        assert.match(
          pmFails.stderr,
          /UpdateError: vibest 999\.0\.0 cannot take over: it could not be fetched to try it first \((bun add --cwd|npm install --prefix) \S+ @vibest\/cli@999\.0\.0.*: exit 1\)\. Nothing was installed: vibest \S+ stays/,
        )
        assert.notMatch(yield* fs.readFileString(`${home}/pm.log`), / -g /, "a failed try installs nothing")
        assert.notInclude(pmFails.stderr, "not replaced")
        assert.notInclude(pmFails.stdout, "old version")

        const fromSource = yield* runVibest(
          home,
          { HOME: home, VIBEST_HOME: `${home}/vibest`, PATH: `${home}/bin:/bin:/usr/bin` },
          ["update"],
        )
        assert.match(
          fromSource.stdout,
          /^this vibest \(.*\) was not installed by npm or install\.sh; nothing to install\.\n/,
        )
        assert.include(fromSource.stdout, "vibestd: restart. vibestd 0.0.0 cannot hand itself over")

        for (const [dir, v] of [
          ["a", "1.0.0"],
          ["b", "2.0.0"],
        ] as const) {
          yield* fs.makeDirectory(`${home}/${dir}`)
          yield* fs.writeFileString(`${home}/${dir}/vibest`, `#!/bin/sh\necho "vibest v${v}"\n`)
          yield* fs.chmod(`${home}/${dir}/vibest`, 0o755)
        }
        const two = yield* runVibest(
          home,
          { HOME: home, VIBEST_HOME: `${home}/vibest`, PATH: `${home}/a:${home}/b:/bin:/usr/bin` },
          ["update"],
        )
        assert.include(two.stdout, `${home}/a/vibest 1.0.0 runs as vibest; 1 more on PATH\n`)
        assert.include(
          two.stdout,
          `warning: ${home}/b/vibest 2.0.0 is also on PATH, behind the first; remove it with: rm ${home}/b/vibest\n`,
        )

        const agent = yield* runVibest(
          home,
          { HOME: home, VIBEST_AGENT: "general", VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" },
          ["update"],
        )
        assert.match(agent.stderr, /^Forbidden: an agent may not run vibest update/)
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(Platform.services, builtinHarnesses))),
    60_000,
  )
})
