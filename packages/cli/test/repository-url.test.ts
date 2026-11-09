import { assert, describe, it } from "@effect/vitest"
import { parseRemote, repositoryIdentity, SshHosts } from "@vibest/core/repository-url"
import { Effect, Layer } from "effect"

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
})
