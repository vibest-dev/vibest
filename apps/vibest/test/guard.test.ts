import { assert, describe, it, layer } from "@effect/vitest"
import { SocketConnector as VibestSocketConnector } from "@vibest/client/socket-connector"
// The guard (guard.ts): everything runs but what a rule names, for the coordinator and for every other session, as every harness's hook sees them.
import { Agents } from "@vibest/core/agents"
import { coordinator, GuardArea, HARNESS_CLIS, type Rules, session, shellBlock, splitCommand } from "@vibest/core/guard"
import { BUILTIN as ADAPTERS, layer as builtinHarnesses } from "@vibest/core/harnesses"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { Forbidden } from "@vibest/protocol/rpc"
import { toolCallOf } from "@vibest/protocol/tools"
import { LaunchFailed } from "@vibest/schema/session"
import type { Host } from "@vibest/server/daemon"
import { guardArea } from "@vibest/vibest/guard-area"
import {
  Cause,
  Config,
  ConfigProvider,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Queue,
  Stdio,
  Terminal,
} from "effect"
import { SocketConnector } from "effect-herdr-sdk"
import { Command } from "effect/cli"
import { ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

import * as Cli from "../src/cli.ts"
import { makeRepository, tempDirectory } from "./fakes.ts"

/** vibest's guard area as vibestd gives it (server/http.ts): the Layout's home and projects, and the caller's project folder (VIBEST_PROJECT_DIR here). */
const vibestArea = Effect.gen(function* () {
  const layout = yield* Layout
  const allowed = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_PROJECT_DIR")))
  return guardArea(layout, allowed)
})

const source = ["/usr/bin/bun", "/src/main.ts"]
const both = (command: string) => [shellBlock(command, source, true), shellBlock(command, source, false)]

describe("Shell denials", () => {
  it("run anything no rule names: unlisted programs, env prefixes, any shell syntax, quoted task data, any vibest command", () => {
    for (const command of [
      // Programs and shapes the old read-only allowlist refused.
      "touch x",
      "echo hi > y",
      "jq . package.json",
      "sort a | uniq -c",
      "X=push git status",
      "FOO=1 bun test",
      "env -i PATH=/bin ls",
      "git commit -m x",
      "git push",
      "git merge main",
      "git rebase main",
      "git worktree remove /tmp/x",
      "git branch -D foo",
      "sed -i s/a/b/ f",
      "gh pr merge 12 --squash",
      "git -c core.pager=cat diff",
      "rg --pre cat x",
      "git diff --output=x",
      "cat $(which sh)",
      "cat `x`",
      'cat "$HOME/x"',
      "git log $REV | head",
      "git status &",
      "(git status)",
      "git status\nrm a",
      "git status > /tmp/s 2>&1",
      "{ ls; }",
      "if true; then ls; fi",
      "",
      // Quoted text is data, here-document bodies and comments too.
      "vibest run pi 'herdr pane list; vibest integration event'",
      "git commit -m 'herdr pane list'",
      'rg "vibest integration event" src',
      "/usr/bin/bun /src/main.ts report -- 'env -u VIBEST_AGENT vibest rm x'",
      "vibest run pi - <<'EOF'\nherdr pane list\nvibest integration event\nEOF",
      "ls # herdr pane list",
      "echo 'claude -p x' && echo \"gh auth token\"",
      // vibest decides who may run its commands (cli.ts userOnly, server.ts ACCESS), not the guard.
      "vibest rm abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "vibest send abcd1234-abcd-4abc-8abc-abcd1234abcd x",
      "vibest ls",
      "vibest daemon restart",
      "vibest --harness pi",
      "vibest --new",
      "vibest update",
      "vibest --wizard",
      "vibest integration guard",
      "vibest inbox pull gen sess",
      "vibest project search needle",
      "/usr/bin/bun /src/main.ts interrupt abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "/usr/local/bin/vibest archive abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "vibest send x -- integration event",
      // Reading the identity is not changing it.
      "echo $VIBEST_SESSION_ID",
      "printenv VIBEST_AGENT",
    ])
      assert.deepStrictEqual(both(command), [undefined, undefined], command)
  })

  it("refuse herdr control wherever it runs: wrapped, nested, by path", () => {
    for (const command of [
      "herdr pane list",
      "herdr worktree remove --workspace w1",
      "ls && herdr tab close 1",
      "/usr/local/bin/herdr agent list",
      "echo $(herdr pane list)",
      "x=`herdr workspace list`",
      "bash -lc 'herdr session list'",
      'sh -c "herdr server stop"',
      "eval herdr pane list",
      "env A=1 nohup herdr pane close 1",
      "echo a | xargs -n 1 herdr pane close",
      "cat <<EOF\nx\nEOF\nherdr pane list",
    ])
      for (const reason of both(command)) assert.match(reason ?? "", /^Agents must not control herdr/, command)
    // A session runs no herdr at all (Claude's old `Bash(herdr:*)`); the coordinator's non-control herdr runs.
    for (const command of ["herdr --help", "herdr", "ls && herdr status", "env A=1 /opt/bin/herdr --version"])
      assert.deepStrictEqual(both(command), [undefined, "Sessions do not run herdr; vibest manages it."], command)
  })

  it("refuse vibest with its identity variables changed or cleared, however it is wrapped or spelled", () => {
    for (const command of [
      "env -u VIBEST_AGENT vibest rm abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "env -uVIBEST_SESSION_ID vibest ls",
      "env --unset=VIBEST_AGENT vibest ls",
      "env -i PATH=/bin vibest interrupt abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "env - vibest ls",
      "VIBEST_AGENT= vibest rm abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "VIBEST_SESSION_ID=x /usr/bin/bun /src/main.ts send abcd1234-abcd-4abc-8abc-abcd1234abcd x",
      "env VIBEST_SESSION_ID= /usr/local/bin/vibest ls",
      "unset VIBEST_SESSION_ID; vibest rm abcd1234-abcd-4abc-8abc-abcd1234abcd",
      "export VIBEST_AGENT=coordinator && vibest ls",
      "VIBEST_SESSION_ID=; vibest ls",
      "sh -c 'env -u VIBEST_AGENT vibest rm abcd1234-abcd-4abc-8abc-abcd1234abcd'",
      "echo $(VIBEST_AGENT= vibest rm abcd1234-abcd-4abc-8abc-abcd1234abcd)",
      "nohup env -i vibest daemon restart",
      "echo a | VIBEST_AGENT= xargs vibest rm",
    ])
      for (const reason of both(command))
        assert.match(reason ?? "", /^vibest runs with the agent's own VIBEST_SESSION_ID and VIBEST_AGENT/, command)
  })

  it("refuse vibest integration event, the harness's hook bridge, however it is wrapped", () => {
    for (const command of [
      "vibest integration event",
      "/usr/bin/bun /src/main.ts integration event",
      "vibest --log-level debug integration event < x.json",
      "echo '{}' | vibest integration event",
      "x=`vibest integration event`",
      "nohup timeout 5 vibest integration event",
      "bash -c 'vibest integration event'",
    ])
      for (const reason of both(command))
        assert.match(reason ?? "", /^vibest integration event is the harness's hook bridge/, command)
  })

  it("other integration commands are vibest's own to check", () => {
    assert.isUndefined(shellBlock("vibest integration guard", source, false))
  })

  it("the coordinator also does not start harness CLIs (they would report as it) or run gh's credential and config commands", () => {
    for (const command of [
      "claude -p x",
      "pi -p x",
      "cursor-agent -p x",
      "/usr/local/bin/claude",
      "env A=1 pi",
      "gh auth token",
      "gh config set pager x",
      "gh alias set x y",
      "gh extension install a/b",
      "gh ext install a/b",
    ]) {
      assert.isString(shellBlock(command, source, true), command)
      assert.isUndefined(shellBlock(command, source, false), command)
    }
    assert.deepStrictEqual(
      [...HARNESS_CLIS].sort(),
      Object.values(ADAPTERS)
        .map((a) => a.binary)
        .sort(),
    )
  })

  it("splits at unquoted separators, leaves out redirections and here-documents, and adds substitutions", () => {
    assert.deepStrictEqual(splitCommand(`rg 'a|b' "c;d" && git log`), [
      ["rg", "a|b", "c;d"],
      ["git", "log"],
    ])
    assert.deepStrictEqual(splitCommand("echo '$x'"), [["echo", "$x"]])
    assert.deepStrictEqual(splitCommand("echo 'open"), [["echo", "open"]])
    assert.deepStrictEqual(splitCommand("git diff 2>&1 > /tmp/x | head -5"), [
      ["git", "diff"],
      ["head", "-5"],
    ])
    assert.deepStrictEqual(splitCommand('echo "a $(git rev-parse HEAD) b" `ls`'), [
      ["echo", "a $(git rev-parse HEAD) b", "`ls`"],
      ["git", "rev-parse", "HEAD"],
      ["ls"],
    ])
    assert.deepStrictEqual(splitCommand("cat <<-'EOF' | wc -l\n\tbody; rm x\n\tEOF\nls"), [
      ["cat"],
      ["wc", "-l"],
      ["ls"],
    ])
  })
})

layer(Platform.services)("role rules", (it) => {
  it.effect("Coordinator: file edits only in its project folder (VIBEST_PROJECT_DIR), symlinks and .. followed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("vibest-guard-")
      const vibestHome = path.join(home, ".vibest")
      const own = path.join(vibestHome, "projects", "own")
      const other = path.join(vibestHome, "projects", "other")
      yield* fs.makeDirectory(path.join(own, "artifacts"), { recursive: true })
      yield* fs.makeDirectory(other, { recursive: true })
      yield* fs.symlink(other, path.join(own, "artifacts", "out"))
      const asCoordinator = (tool: string, input: Record<string, unknown>, dir: string | null = own) =>
        coordinator(toolCallOf(tool, input, home)).pipe(
          Effect.provideServiceEffect(GuardArea, vibestArea),
          Effect.provideServiceEffect(Layout, Layout.make(vibestHome)),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown(dir === null ? { HOME: home } : { HOME: home, VIBEST_PROJECT_DIR: dir }),
            ),
          ),
        )
      for (const [tool, input] of [
        ["Write", { file_path: path.join(own, "artifacts", "plan.md"), content: "x" }],
        ["Edit", { file_path: path.join(own, "memories", "a.md"), old_string: "a", new_string: "b" }],
        ["write", { path: "~/.vibest/projects/own/docs/a.md" }],
        ["edit", { path: ".vibest/projects/own/artifacts/x/../plan.md" }],
      ] as const)
        assert.isUndefined(yield* asCoordinator(tool, input), JSON.stringify(input))
      for (const [tool, input] of [
        ["Write", { file_path: "a" }],
        ["Write", { file_path: path.join(other, "a.md") }],
        ["Write", { file_path: `${own}2/a.md` }],
        ["Edit", { file_path: path.join(own, "artifacts", "..", "..", "other", "a.md") }],
        ["Write", { file_path: path.join(own, "artifacts", "out", "a.md") }],
        ["Write", {}],
      ] as const)
        assert.isString(yield* asCoordinator(tool, input), JSON.stringify(input))
      // Without VIBEST_PROJECT_DIR: no edits at all.
      assert.isString(yield* asCoordinator("Write", { file_path: path.join(own, "artifacts", "plan.md") }, null))
    }),
  )

  it.effect("a dangling symlink is judged by where it points; one whose target cannot be resolved is refused", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("vibest-guard-")
      const vibestHome = path.join(home, ".vibest")
      const own = path.join(vibestHome, "projects", "own")
      const other = path.join(vibestHome, "projects", "other")
      const work = path.join(vibestHome, "worktrees", "abcd1234-abcd-4abc-8abc-abcd1234abcd")
      yield* fs.makeDirectory(path.join(own, "artifacts"), { recursive: true })
      yield* fs.makeDirectory(path.join(other, "artifacts"), { recursive: true })
      yield* fs.makeDirectory(work, { recursive: true })
      // The target does not exist yet: realPath fails, and a write would create it there.
      const outside = path.join(home, "outside.md")
      const stolen = path.join(other, "artifacts", "stolen.md")
      yield* fs.symlink(outside, path.join(own, "artifacts", "leak"))
      yield* fs.symlink(path.join(own, "artifacts", "plan.md"), path.join(own, "artifacts", "alias"))
      yield* fs.symlink("loop", path.join(own, "artifacts", "loop"))
      yield* fs.symlink(stolen, path.join(work, "leak"))
      const provide =
        (rules: Rules, dir: string | null) => (tool: string, input: Record<string, unknown>, cwd: string) =>
          rules(toolCallOf(tool, input, cwd)).pipe(
            Effect.provideServiceEffect(GuardArea, vibestArea),
            Effect.provideServiceEffect(Layout, Layout.make(vibestHome)),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown(dir === null ? { HOME: home } : { HOME: home, VIBEST_PROJECT_DIR: dir }),
              ),
            ),
          )
      const asCoordinator = provide(coordinator, own)
      const asSession = provide(session, own)
      const edits =
        "The coordinator edits files only in the project folder (VIBEST_PROJECT_DIR); hand other changes to a session."
      const offLimits =
        "The projects directory is off limits to sessions, except this project's folder (VIBEST_PROJECT_DIR)."
      const unresolved = "The path is a symlink that refers to itself or whose target cannot be read; refused."
      assert.strictEqual(yield* asCoordinator("Write", { file_path: path.join(own, "artifacts", "leak") }, home), edits)
      assert.isUndefined(yield* asCoordinator("Write", { file_path: path.join(own, "artifacts", "alias") }, home))
      assert.strictEqual(
        yield* asCoordinator("Write", { file_path: path.join(own, "artifacts", "loop") }, home),
        unresolved,
      )
      assert.strictEqual(yield* asSession("Write", { file_path: path.join(work, "leak") }, work), offLimits)
      assert.isUndefined(yield* asSession("Write", { file_path: path.join(own, "artifacts", "alias") }, work))
      assert.strictEqual(
        yield* asSession("Write", { file_path: path.join(own, "artifacts", "loop") }, work),
        unresolved,
      )
    }),
  )

  it.effect("a path through a file (ENOTDIR) is judged as written, not as an unreadable link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("vibest-guard-")
      const vibestHome = path.join(home, ".vibest")
      const own = path.join(vibestHome, "projects", "own")
      const work = path.join(vibestHome, "worktrees", "abcd1234-abcd-4abc-8abc-abcd1234abcd")
      yield* fs.makeDirectory(path.join(own, "artifacts"), { recursive: true })
      yield* fs.makeDirectory(work, { recursive: true })
      yield* fs.writeFileString(path.join(work, "file.txt"), "x")
      yield* fs.writeFileString(path.join(own, "artifacts", "file.txt"), "x")
      const asSession = (tool: string, input: Record<string, unknown>) =>
        session(toolCallOf(tool, input, work)).pipe(
          Effect.provideServiceEffect(GuardArea, vibestArea),
          Effect.provideServiceEffect(Layout, Layout.make(vibestHome)),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home, VIBEST_PROJECT_DIR: own }))),
        )
      // cat file.txt/x: readLink is ENOTDIR. The lexical path is outside the projects directory, so it is allowed.
      assert.isUndefined(yield* asSession("Bash", { command: `cat ${path.join(work, "file.txt")}/x` }))
      const asCoordinator = (input: Record<string, unknown>) =>
        coordinator(toolCallOf("Write", input, work)).pipe(
          Effect.provideServiceEffect(GuardArea, vibestArea),
          Effect.provideServiceEffect(Layout, Layout.make(vibestHome)),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home, VIBEST_PROJECT_DIR: own }))),
        )
      assert.isUndefined(
        yield* asCoordinator({ file_path: path.join(own, "artifacts", "file.txt", "x"), content: "y" }),
      )
    }),
  )

  it.effect(
    "Coordinator: no edits without its project folder; session: no herdr control and no project directory, symlinks included",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* tempDirectory("vibest-guard-")
        const vibestHome = path.join(home, ".vibest")
        yield* fs.makeDirectory(path.join(vibestHome, "projects"), { recursive: true })
        yield* fs.symlink(path.join(vibestHome, "projects"), path.join(home, "link"))
        const as = (rules: Rules) => (tool: string, input: Record<string, unknown>) =>
          rules(toolCallOf(tool, input, home)).pipe(
            Effect.provideServiceEffect(GuardArea, vibestArea),
            Effect.provideServiceEffect(Layout, Layout.make(vibestHome)),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
          )
        const asCoordinator = as(coordinator)
        const asSession = as(session)

        assert.isString(yield* asCoordinator("Write", { file_path: "a" }))
        assert.isUndefined(yield* asCoordinator("bash", { command: "rm a" }))
        assert.isUndefined(yield* asCoordinator("Read", { file_path: "a" }))
        assert.isUndefined(yield* asCoordinator("Grep", { pattern: "a" }))

        assert.isString(yield* asSession("Bash", { command: "herdr pane list" }))
        assert.isString(yield* asSession("Bash", { command: "cat ~/.vibest/projects/x" }))
        assert.isString(yield* asSession("Read", { file_path: "link/x.md" }))
        assert.isString(yield* asSession("read", { path: "~/.vibest/projects" }))
        assert.isUndefined(yield* asSession("Edit", { file_path: "src/a.ts" }))
        assert.isUndefined(yield* asSession("Bash", { command: "git push" }))
        assert.isString(yield* asSession("bash", { command: "herdr --help" }))
      }),
  )

  it.effect(
    "Session: only its own project folder (VIBEST_PROJECT_DIR) under projects; another project's folder, the projects directory itself and everything without VIBEST_PROJECT_DIR are refused; no herdr",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* tempDirectory("vibest-guard-")
        const vibestHome = path.join(home, ".vibest")
        const projects = path.join(vibestHome, "projects")
        const worktree = path.join(vibestHome, "worktrees", "abcd1234-abcd-4abc-8abc-abcd1234abcd")
        yield* fs.makeDirectory(worktree, { recursive: true })
        const own = path.join(projects, "0f5a8b2c-1d3e-4f60-8a7b-9c0d1e2f3a4b")
        const other = path.join(projects, "7c1e9d20-3b4a-4c5d-9e6f-0a1b2c3d4e5f")
        for (const dir of [own, other])
          for (const kind of ["docs", "memories", "artifacts"])
            yield* fs.makeDirectory(path.join(dir, kind), { recursive: true })
        const asSession = (tool: string, input: Record<string, unknown>, dir: string | null = own) =>
          session(toolCallOf(tool, input, worktree)).pipe(
            Effect.provideServiceEffect(GuardArea, vibestArea),
            Effect.provideServiceEffect(Layout, Layout.make(vibestHome)),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown(dir === null ? { HOME: home } : { HOME: home, VIBEST_PROJECT_DIR: dir }),
              ),
            ),
          )
        const offLimits =
          "The projects directory is off limits to sessions, except this project's folder (VIBEST_PROJECT_DIR)."
        const calls = (dir: string, file: string) =>
          [
            ["Read", { file_path: file }],
            ["Write", { file_path: file, content: "x" }],
            ["Edit", { file_path: file, old_string: "a", new_string: "b" }],
            ["NotebookRead", { notebook_path: file }],
            ["Glob", { pattern: "**/*.md", path: dir }],
            ["Glob", { pattern: `${dir}/**/*.md` }],
            ["Grep", { pattern: "x", path: dir }],
            ["Bash", { command: `cat ${file}` }],
            ["Bash", { command: `grep -r x ${dir}` }],
          ] as const
        // Its own folder: read, write, search, in every subfolder.
        for (const dir of [own, ...["docs", "memories", "artifacts"].map((kind) => path.join(own, kind))])
          for (const [tool, input] of calls(dir, path.join(dir, "notes.md")))
            assert.isUndefined(yield* asSession(tool, input), `${tool} ${JSON.stringify(input)}`)
        for (const [tool, input] of calls(own, path.join(own, "instructions.md")))
          assert.isUndefined(yield* asSession(tool, input), `${tool} ${JSON.stringify(input)}`)
        // Another project's folder, one whose name starts with its own, and the projects directory: refused.
        for (const [dir, file] of [
          [other, path.join(other, "instructions.md")],
          [path.join(other, "artifacts"), path.join(other, "artifacts", "a.md")],
          [path.join(other, "memories"), path.join(other, "memories", "a.md")],
          [`${own}2`, `${own}2/a.md`],
          [projects, path.join(projects, "a.md")],
        ] as const)
          for (const [tool, input] of calls(dir, file))
            assert.strictEqual(yield* asSession(tool, input), offLimits, `${tool} ${JSON.stringify(input)}`)
        // A search over a directory holding the projects directory reaches into it.
        for (const [tool, input] of [
          ["Grep", { pattern: "x", path: vibestHome }],
          ["Glob", { pattern: `${vibestHome}/**/instructions.md` }],
          ["Bash", { command: `grep -r x ${vibestHome}` }],
        ] as const)
          assert.strictEqual(yield* asSession(tool, input), offLimits, `${tool} ${JSON.stringify(input)}`)
        // No VIBEST_PROJECT_DIR: nothing under projects, its own folder included.
        for (const [tool, input] of calls(own, path.join(own, "notes.md")))
          assert.strictEqual(yield* asSession(tool, input, null), offLimits, `no VIBEST_PROJECT_DIR: ${tool}`)
        // Outside projects it is unchanged, and no herdr at all.
        assert.isUndefined(yield* asSession("Read", { file_path: path.join(worktree, "src/a.ts") }, null))
        assert.isUndefined(yield* asSession("Grep", { pattern: "x" }))
        for (const command of ["herdr pane list", "herdr --help", "cd /tmp && herdr"])
          assert.isString(yield* asSession("Bash", { command }), command)
      }),
  )

  it.effect(
    "Session: a shell whose cwd is in another project is refused (bare names are its files); its own folder or worktree is fine",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* tempDirectory("vibest-guard-")
        const vibestHome = path.join(home, ".vibest")
        const own = path.join(vibestHome, "projects", "k")
        const other = path.join(vibestHome, "projects", "j")
        yield* fs.makeDirectory(path.join(own, "artifacts"), { recursive: true })
        yield* fs.makeDirectory(path.join(other, "docs"), { recursive: true })
        yield* fs.symlink(other, path.join(home, "p"))
        const asSession = (tool: string, command: string, cwd: string) =>
          session(toolCallOf(tool, { command }, cwd)).pipe(
            Effect.provideServiceEffect(GuardArea, vibestArea),
            Effect.provideServiceEffect(Layout, Layout.make(vibestHome)),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home, VIBEST_PROJECT_DIR: own }))),
          )
        for (const tool of ["Bash", "Shell"]) {
          for (const cwd of [other, path.join(other, "docs"), path.join(home, "p"), path.join(vibestHome, "projects")])
            for (const command of ["cat instructions.md", "cat a.md", "ls"])
              assert.isString(yield* asSession(tool, command, cwd), `${tool} ${cwd}: ${command}`)
          for (const cwd of [
            own,
            path.join(own, "artifacts"),
            path.join(vibestHome, "worktrees", "abcd1234-abcd-4abc-8abc-abcd1234abcd"),
            home,
          ])
            assert.isUndefined(yield* asSession(tool, "cat a.md && ls", cwd), `${tool} ${cwd}`)
        }
      }),
  )

  it.effect("Session: its own project folder is the one project directory it may use", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("vibest-guard-")
      const vibestHome = path.join(home, ".vibest")
      const own = path.join(vibestHome, "projects", "k")
      const work = path.join(own, "artifacts", "w1")
      yield* fs.makeDirectory(work, { recursive: true })
      const asSession = (tool: string, input: Record<string, unknown>) =>
        session(toolCallOf(tool, input, home)).pipe(
          Effect.provideServiceEffect(GuardArea, vibestArea),
          Effect.provideServiceEffect(Layout, Layout.make(vibestHome)),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home, VIBEST_PROJECT_DIR: own }))),
        )
      const tilde = "~/.vibest/projects/k/artifacts/w1"
      for (const [tool, input] of [
        ["Write", { file_path: `${work}/notes.md` }],
        ["read", { path: `${tilde}/notes.md` }],
        ["Bash", { command: `cat ${work}/a.md > ${tilde}/b.md` }],
        ["Bash", { command: `ls ${work}` }],
        ["Bash", { command: `cat ${work}2/a.md` }],
        ["Read", { file_path: path.join(own, "docs", "a.md") }],
        ["Bash", { command: `cat ${tilde}/../../memories/x.md` }],
      ] as const)
        assert.isUndefined(yield* asSession(tool, input), JSON.stringify(input))
      for (const [tool, input] of [
        ["Read", { file_path: `${work}/../../../j/memories/a.md` }],
        ["Read", { file_path: path.join(vibestHome, "projects", "j", "docs", "a.md") }],
        ["Bash", { command: `cat ${work}/../../../j/memories/a.md` }],
        ["Bash", { command: `ls ${work} ~/.vibest/projects/j/memories` }],
        ["Bash", { command: `cat ${own}2/a.md` }],
      ] as const)
        assert.isString(yield* asSession(tool, input), JSON.stringify(input))
    }),
  )

  it.effect(
    "Session: paths are followed as the system would (.. anywhere, symlinks, relative, globs) and searches above the project refused",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* tempDirectory("vibest-guard-")
        const vibestHome = path.join(home, ".vibest")
        const project = path.join(vibestHome, "projects", "own")
        const other = path.join(vibestHome, "projects", "other")
        const work = path.join(project, "artifacts", "w1")
        const peer = path.join(other, "artifacts", "w2")
        yield* fs.makeDirectory(work, { recursive: true })
        yield* fs.makeDirectory(peer, { recursive: true })
        yield* fs.makeDirectory(path.join(other, "docs", "sub"), { recursive: true })
        yield* fs.makeDirectory(path.join(project, "docs", "sub"), { recursive: true })
        yield* fs.makeDirectory(path.join(home, "src"), { recursive: true })
        yield* fs.symlink(peer, path.join(work, "peer"))
        yield* fs.symlink(path.join(other, "docs", "sub"), path.join(work, "deep"))
        yield* fs.symlink(path.join(project, "docs", "sub"), path.join(work, "mine"))
        const asSession = (tool: string, input: Record<string, unknown>) =>
          session(toolCallOf(tool, input, home)).pipe(
            Effect.provideServiceEffect(GuardArea, vibestArea),
            Effect.provideServiceEffect(Layout, Layout.make(vibestHome)),
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home, VIBEST_PROJECT_DIR: project })),
            ),
          )
        for (const [tool, input] of [
          ["Bash", { command: `cat ${work}/x/../a.md` }],
          ["Bash", { command: "git commit -m 'fix: a/b' && bun test src/a.test.ts" }],
          ["Bash", { command: "cd ~/.vibest/worktrees/abcd1234-abcd-4abc-8abc-abcd1234abcd && ls" }],
          ["Bash", { command: `rg TODO ${work}` }],
          ["Bash", { command: "rg TODO src ~/notes.md" }],
          ["Bash", { command: `ls ${home}` }],
          ["Read", { file_path: `${work}/mine/a.md` }],
          ["Read", { file_path: `${work}/../../docs/a.md` }],
          ["Read", { file_path: ".vibest/projects/own/docs/a.md" }],
          ["Grep", { pattern: "x", path: "src" }],
          ["Grep", { pattern: "x" }],
          ["Glob", { pattern: "src/**/*.ts" }],
          ["Read", { file_path: "src/a.ts" }],
        ] as const)
          assert.isUndefined(yield* asSession(tool, input), JSON.stringify(input))
        for (const [tool, input] of [
          // `..` further on, not only right after its folder.
          ["Bash", { command: `cat ${work}/x/../../../../other/docs/secret.md` }],
          ["Read", { file_path: `${work}/x/../../../../other/docs/secret.md` }],
          // A symlink in its folder to another project's (and `..` taken after the link, as the system does).
          ["Read", { file_path: `${work}/peer/a.md` }],
          ["Bash", { command: `cat ${work}/peer/a.md` }],
          ["Grep", { pattern: "x", path: `${work}/peer` }],
          ["Edit", { file_path: `${work}/deep/../a.md` }],
          // Relative to the cwd, and through vibest's home.
          ["Read", { file_path: ".vibest/projects/other/docs/a.md" }],
          ["Bash", { command: "cd ~/.vibest && cat projects/other/docs/a.md" }],
          ["Bash", { command: "cat ~/.vibest/proj*/other/docs/a.md" }],
          // After a `cd` the hook cannot follow: another project's path spelled out is enough.
          ["Bash", { command: "cd ~ && cat .vibest/projects/other/docs/a.md" }],
          // A tree-walking program from above the project (the simple forms; a shell is not parsed in full).
          ["Bash", { command: "rg secret ~" }],
          ["Bash", { command: `grep -r secret ${vibestHome}` }],
          ["Bash", { command: "find ~/ -name '*.md'" }],
          ["Bash", { command: "cat --file=~/.vibest/projects/other/memories/a" }],
          // Searches from above the project reach into it.
          ["Grep", { pattern: "x", path: "~" }],
          ["Grep", { pattern: "x", path: vibestHome }],
          ["Glob", { pattern: "~/.vibest/**/*.md" }],
          ["find", { path: home }],
          ["NotebookEdit", { notebook_path: path.join(other, "docs", "n.ipynb") }],
          // Malformed: refused, not let through.
          ["Bash", {}],
          ["Bash", { command: 1 }],
        ] as const)
          assert.isString(yield* asSession(tool, input), JSON.stringify(input))
      }),
  )

  it.effect(
    "Both roles, every shell shape: vibest goes to vibest's own checks unless the command changes who it speaks as",
    () =>
      Effect.gen(function* () {
        const as = (rules: Rules, tool: string, command: string) =>
          rules(toolCallOf(tool, { command }, "/")).pipe(
            Effect.provideService(VibestCommand, source),
            Effect.provideServiceEffect(GuardArea, vibestArea),
            Effect.provideServiceEffect(Layout, Layout.make("/nonexistent/.vibest")),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/nonexistent" }))),
          )
        for (const rules of [coordinator, session]) {
          for (const tool of ["Bash", "Shell"]) {
            for (const command of [
              "vibest rm abcd1234-abcd-4abc-8abc-abcd1234abcd",
              "vibest daemon restart",
              "/usr/bin/bun /src/main.ts send abcd1234-abcd-4abc-8abc-abcd1234abcd x",
              "jq . a.json > /tmp/b",
              "git log $REV",
            ])
              assert.isUndefined(yield* as(rules, tool, command), `${tool}: ${command}`)
            for (const command of [
              "env -u VIBEST_AGENT vibest rm abcd1234-abcd-4abc-8abc-abcd1234abcd",
              "VIBEST_SESSION_ID= /usr/bin/bun /src/main.ts rm abcd1234-abcd-4abc-8abc-abcd1234abcd",
              "vibest integration event",
              "herdr pane list",
            ])
              assert.isString(yield* as(rules, tool, command), `${tool}: ${command}`)
          }
        }
        // Not a shell call vibest can read: refused, not let through.
        for (const rules of [coordinator, session])
          assert.isString(
            yield* rules(toolCallOf("Bash", {}, "/")).pipe(
              Effect.provideServiceEffect(GuardArea, vibestArea),
              Effect.provideServiceEffect(Layout, Layout.make("/nonexistent/.vibest")),
              Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/nonexistent" }))),
            ),
          )
      }),
  )

  it.effect("Coordinator: no file edits by any tool, unknown tools allowed", () =>
    Effect.gen(function* () {
      const as = (tool: string, input: Record<string, unknown>) =>
        coordinator(toolCallOf(tool, input, "/")).pipe(
          Effect.provideServiceEffect(GuardArea, vibestArea),
          Effect.provideServiceEffect(Layout, Layout.make("/nonexistent/.vibest")),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/nonexistent" }))),
        )
      for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"])
        assert.isString(yield* as(tool, { file_path: "a" }), tool)
      for (const tool of ["TodoWrite", "WebFetch", "Task", "mcp__x__y"]) assert.isUndefined(yield* as(tool, {}), tool)
    }),
  )
})

describe("wizard entry", () => {
  it.effect(
    "a confirmed --wizard reaches the handler, and a session stops at userOnly before spawn, exec or the daemon host",
    () =>
      Effect.gen(function* () {
        const touched = { spawn: false, exec: false, host: false, socket: false }
        const enter: Terminal.UserInput = {
          input: Option.none(),
          key: { name: "enter", ctrl: false, meta: false, shift: false },
        }
        const keys = yield* Queue.unbounded<Terminal.UserInput>()
        // Root's first subcommand is daemon; its only child is restart; the run toggle defaults to yes.
        yield* Queue.offerAll(keys, [enter, enter, enter])
        const terminal = Terminal.make({
          columns: Effect.succeed(80),
          rows: Effect.succeed(24),
          readInput: Effect.succeed(keys),
          readLine: Effect.die("readline"),
          display: () => Effect.void,
        })
        const host = new Proxy({} as Host, {
          get: () => () => {
            touched.host = true
            return Effect.die("host")
          },
        })
        const exit = yield* Command.runWith(
          Cli.command(host, () => {
            touched.exec = true
          }),
          { version: "0.0.0-test" },
        )(["--wizard"]).pipe(
          Effect.provideService(Terminal.Terminal, terminal),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => {
              touched.spawn = true
              return Effect.die("spawned")
            }),
          ),
          Effect.provideService(SocketConnector, () => {
            touched.socket = true
            return Effect.die("socket")
          }),
          Effect.provideService(VibestSocketConnector, () => {
            touched.socket = true
            return Effect.die("socket")
          }),
          Effect.provide(builtinHarnesses),
          Effect.provide(Agents.layer),
          Effect.provideService(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          Effect.provide(FileSystem.layerNoop({})),
          Effect.provide(Stdio.layerTest({})),
          Effect.provideServiceEffect(GuardArea, vibestArea),
          Effect.provideServiceEffect(Layout, Layout.make("/nonexistent/.vibest")),
          Effect.provide(Path.layer),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
                VIBEST_AGENT: "general",
                HOME: "/nonexistent",
              }),
            ),
          ),
          Effect.exit,
        )
        const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
        assert.strictEqual(
          error instanceof Forbidden,
          true,
          Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "wizard returned success",
        )
        assert.match(error instanceof Forbidden ? error.message : "", /an agent may not run vibest daemon restart/)
        assert.deepStrictEqual(touched, { spawn: false, exec: false, host: false, socket: false })
      }),
    15_000,
  )
})

describe("vibest --session inside herdr", () => {
  it.effect(
    "the parent-workspace pane refuses --session before any exec, herdr call or vibestd start",
    () =>
      Effect.gen(function* () {
        const touched = { exec: false, host: false, socket: false }
        const repo = yield* makeRepository.pipe(Effect.provide(Platform.services))
        // `--in-parent <root>` marks this pane as the parent workspace's, so herdr is not asked which workspace it is in.
        const back = process.cwd()
        process.chdir(repo)
        const host = new Proxy({} as Host, {
          get: () => () => {
            touched.host = true
            return Effect.die("host")
          },
        })
        const exit = yield* Command.runWith(
          Cli.command(host, () => {
            touched.exec = true
          }),
          { version: "0.0.0-test" },
        )(["--session", "other", "--in-parent", repo]).pipe(
          Effect.provideService(SocketConnector, () => {
            touched.socket = true
            return Effect.die("herdr socket")
          }),
          Effect.provideService(VibestSocketConnector, () => {
            touched.socket = true
            return Effect.die("socket")
          }),
          Effect.provide(builtinHarnesses),
          Effect.provide(Agents.layer),
          Effect.provide(Platform.services),
          Effect.provideServiceEffect(GuardArea, vibestArea),
          Effect.provideServiceEffect(Layout, Layout.make("/nonexistent/.vibest")),
          Effect.provide(Path.layer),
          Effect.provideService(VibestCommand, ["/bin/vibest"]),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                HERDR_PANE_ID: "w1:p1",
                HERDR_SOCKET_PATH: "/h/ambient.sock",
                HOME: "/nonexistent",
              }),
            ),
          ),
          Effect.exit,
          Effect.ensuring(Effect.sync(() => process.chdir(back))),
        )
        const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
        assert.strictEqual(
          error instanceof LaunchFailed,
          true,
          Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "vibest started the main agent",
        )
        assert.match(error instanceof LaunchFailed ? error.message : "", /--session other/)
        assert.deepStrictEqual(touched, { exec: false, host: false, socket: false })
      }),
    15_000,
  )
})
