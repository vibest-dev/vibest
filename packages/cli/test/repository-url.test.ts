import { assert, describe, it } from "@effect/vitest"
import { parseRemote, repositoryIdentity, SshHosts } from "@vibest/core/repository-url"
import { Context, Effect, Fiber, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

const hosts = Layer.succeed(SshHosts, {
  hostName: (alias) => Effect.succeed(alias === "gh-me" ? "GitHub.com" : alias),
})

describe("repository identity", () => {
  it("parses scp, ssh://, https with and without .git; local paths have none", () => {
    assert.deepStrictEqual(parseRemote("git@github.com:o/r.git"), { host: "github.com", path: "o/r", ssh: true })
    assert.deepStrictEqual(parseRemote("ssh://git@github.com:22/o/r.git"), {
      host: "github.com",
      path: "o/r",
      ssh: true,
    })
    assert.deepStrictEqual(parseRemote("https://github.com/o/r.git"), { host: "github.com", path: "o/r", ssh: false })
    assert.deepStrictEqual(parseRemote("https://u:p@GitHub.com:8443/o/r/"), {
      host: "GitHub.com",
      path: "o/r",
      ssh: false,
    })
    for (const local of ["/srv/r.git", "./r", "file:///srv/r.git", "../a:b"])
      assert.isUndefined(parseRemote(local), local)
  })

  it.effect("one identity for every form; an ssh alias resolves, an https host is never looked up", () =>
    Effect.gen(function* () {
      const forms = [
        "git@github.com:o/r.git",
        "ssh://git@github.com/o/r",
        "https://github.com/o/r.git",
        "https://GITHUB.com/o/r",
        "git@gh-me:o/r.git",
        "ssh://gh-me:2222/o/r.git",
      ]
      for (const url of forms) assert.strictEqual(yield* repositoryIdentity(url), "github.com/o/r", url)
      assert.strictEqual(yield* repositoryIdentity("https://gh-me/o/r"), "gh-me/o/r")
      assert.isUndefined(yield* repositoryIdentity("/srv/r.git"))
    }).pipe(Effect.provide(hosts)),
  )

  const fakeSsh = (asked: Array<string>) =>
    Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.map(ChildProcessSpawner.ChildProcessSpawner, (real) =>
        ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand" || command.command !== "ssh") return real.spawn(command)
          const alias = command.args.at(-1)!
          asked.push(alias)
          const script =
            alias === "gh-me"
              ? "printf 'user git\\nhostname GitHub.com\\nport 22\\n'"
              : alias === "broken"
                ? "echo 'hostname nope'; exit 255"
                : alias === "silent"
                  ? "echo 'user git'"
                  : "sleep 30"
          return real.spawn(ChildProcess.make("sh", ["-c", script]))
        }),
      ),
    )

  it.effect("SshHosts runs ssh -G: the hostname line, the alias on a failure or a timeout, only successes cached", () =>
    Effect.gen(function* () {
      const asked: Array<string> = []
      const hosts = yield* Layer.build(SshHosts.layer.pipe(Layer.provide(fakeSsh(asked))))
      const name = Context.get(hosts, SshHosts).hostName
      assert.strictEqual(yield* name("gh-me"), "GitHub.com")
      assert.strictEqual(yield* name("gh-me"), "GitHub.com")
      assert.strictEqual(yield* name("broken"), "broken")
      assert.strictEqual(yield* name("broken"), "broken")
      assert.strictEqual(yield* name("silent"), "silent")
      const slow = yield* Effect.forkChild(name("slow"))
      yield* TestClock.adjust("6 seconds")
      assert.strictEqual(yield* Fiber.join(slow), "slow")
      assert.deepStrictEqual(asked, ["gh-me", "broken", "broken", "silent", "slow"])
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
