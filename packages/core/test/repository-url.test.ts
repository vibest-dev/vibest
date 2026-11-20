import { assert, describe, it } from "@effect/vitest"
import { fetchRemote, RepositoryUrl, repositoryIdentity } from "@vibest/core/repository-url"
import { Effect } from "effect"

const config = (lines: ReadonlyArray<string>) => lines.join("\n")

const sshHosts = RepositoryUrl.Service.of({
  hostName: (alias) => Effect.succeed(alias === "work" ? "Git.Internal.Example" : alias),
})

describe("the remote a repository is known by", () => {
  it("the GitHub CLI default first, then upstream, then origin, then the rest by name; only network fetch URLs", () => {
    const remotes = [
      "remote.zeta.url git@github.com:z/r.git",
      "remote.alpha.url https://gitlab.com/a/r",
      "remote.origin.url git@github.com:me/r.git",
      "remote.upstream.url https://github.com/o/r.git",
      "remote.fork.gh-resolved base",
      "remote.fork.url https://github.com/f/r",
      "remote.local.url /srv/git/r.git",
      "remote.file.url file:///srv/git/r.git",
    ]

    assert.strictEqual(fetchRemote(config(remotes)), "https://github.com/f/r")
    assert.strictEqual(fetchRemote(config(remotes.slice(0, 4))), "https://github.com/o/r.git")
    assert.strictEqual(fetchRemote(config(remotes.slice(0, 3))), "git@github.com:me/r.git")
    assert.strictEqual(fetchRemote(config(remotes.slice(0, 2))), "https://gitlab.com/a/r")
    assert.strictEqual(fetchRemote(config(["remote.fork.gh-resolved base", ...remotes.slice(6)])), undefined)
    assert.strictEqual(
      fetchRemote(config(["remote.my.fork.url https://h.example/o/r", "remote.origin.url /x"])),
      "https://h.example/o/r",
    )
    assert.strictEqual(fetchRemote(""), undefined)
  })

  it.effect("the identity is the host in lower case and the whole path, for any host", () =>
    Effect.gen(function* () {
      const cases = [
        ["git@github.com:o/r.git", "github.com/o/r"],
        ["https://GitHub.com/o/r", "github.com/o/r"],
        ["git@gitlab.com:group/sub/team/r.git", "gitlab.com/group/sub/team/r"],
        ["https://gitlab.example.com:8443/group/sub/r.git", "gitlab.example.com/group/sub/r"],
        ["ssh://git@gitlab.example.com:2222/group/sub/r.git", "gitlab.example.com/group/sub/r"],
        ["https://me@bitbucket.org/team/r.git", "bitbucket.org/team/r"],
        ["git@bitbucket.org:team/r.git", "bitbucket.org/team/r"],
        ["https://gitea.example.org:3000/o/r", "gitea.example.org/o/r"],
        ["work:code/r.git", "git.internal.example/code/r"],
        ["ssh://me@work/~/code/r", "git.internal.example/code/r"],
      ] as const

      for (const [url, identity] of cases) assert.strictEqual(yield* repositoryIdentity(url), identity, url)
      assert.isUndefined(yield* repositoryIdentity("/srv/git/r.git"))
      assert.isUndefined(yield* repositoryIdentity("file:///srv/git/r.git"))
    }).pipe(Effect.provideService(RepositoryUrl.Service, sshHosts)),
  )
})
