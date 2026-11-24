import { assert, describe, it } from "@effect/vitest"
import { projectRemotes, rankedRemotes, RepositoryUrl, repositoryIdentity } from "@vibest/core/repository-url"
import { Effect } from "effect"

const config = (lines: ReadonlyArray<string>) => lines.join("\n")

const sshHosts = RepositoryUrl.Service.of({
  hostName: (alias) => Effect.succeed(alias === "work" ? "Git.Internal.Example" : alias),
})

describe("the remote a repository is known by", () => {
  it("the GitHub CLI default first, then upstream, then origin, then the rest by name", () => {
    const remotes = [
      "remote.zeta.url git@github.com:z/r.git",
      "remote.alpha.url https://gitlab.com/a/r",
      "remote.origin.url git@github.com:me/r.git",
      "remote.upstream.url https://github.com/o/r.git",
      "remote.fork.gh-resolved base",
      "remote.fork.url https://github.com/f/r",
      "remote.my.fork.url https://h.example/o/r",
    ]

    assert.deepStrictEqual(rankedRemotes(config(remotes)), ["fork", "upstream", "origin", "alpha", "my.fork", "zeta"])
    assert.deepStrictEqual(rankedRemotes(config(["remote.fork.gh-resolved base"])), [])
    assert.deepStrictEqual(rankedRemotes(""), [])
  })

  it("projectRemotes picks origin first, then gh-resolved, then remaining remotes in config appearance order", () => {
    const fork = config([
      "remote.upstream.url https://github.com/org/repo.git",
      "remote.upstream.gh-resolved base",
      "remote.origin.url git@github.com:forker/repo.git",
    ])

    assert.deepStrictEqual(projectRemotes(fork), ["origin", "upstream"])
    assert.deepStrictEqual(rankedRemotes(fork), ["upstream", "origin"])

    const noOriginResolved = config([
      "remote.firstremote.url https://github.com/first/repo.git",
      "remote.upstream.url https://github.com/org/repo.git",
      "remote.upstream.gh-resolved base",
      "remote.alpha.url https://github.com/alpha/repo.git",
    ])

    assert.deepStrictEqual(projectRemotes(noOriginResolved), ["upstream", "firstremote", "alpha"])

    const appearanceOrder = config([
      "remote.firstremote.url https://github.com/first/repo.git",
      "remote.alpha.url https://github.com/alpha/repo.git",
    ])

    assert.deepStrictEqual(projectRemotes(appearanceOrder), ["firstremote", "alpha"])
    assert.deepStrictEqual(projectRemotes(config(["remote.fork.gh-resolved base"])), [])
    assert.deepStrictEqual(projectRemotes(""), [])
  })

  it("handles URLs containing .url or .gh-resolved and ignores gh-resolved set to false or empty", () => {
    const dotUrl = config([
      "remote.origin.url https://github.com/org/my.url",
      "remote.backup.url https://github.com/org/repo.gh-resolved.git",
      "remote.my.fork.url https://github.com/fork/my.url.git",
    ])

    assert.deepStrictEqual(projectRemotes(dotUrl), ["origin", "backup", "my.fork"])
    assert.deepStrictEqual(rankedRemotes(dotUrl), ["origin", "backup", "my.fork"])

    const declined = config([
      "remote.firstremote.url https://github.com/first/repo.git",
      "remote.upstream.url https://github.com/org/repo.git",
      "remote.upstream.gh-resolved false",
      "remote.empty.url https://github.com/empty/repo.git",
      "remote.empty.gh-resolved ",
    ])

    assert.deepStrictEqual(projectRemotes(declined), ["firstremote", "upstream", "empty"])
    assert.deepStrictEqual(rankedRemotes(declined), ["upstream", "empty", "firstremote"])
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
