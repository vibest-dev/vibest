import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { historyNaming } from "../src/runner/invariants.ts"
import { World } from "../src/world.ts"
import { capture } from "../src/world/user-env.ts"

const zsh = Bun.which("zsh")

const fakeHome = async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vbe-env-test-"))
  const history = path.join(home, ".zsh_history")
  await fs.writeFile(history, ": 1700000000:0;echo earlier\n")
  await fs.writeFile(
    path.join(home, ".zshrc"),
    [
      '[ -z "$HISTFILE" ] && HISTFILE=$HOME/.zsh_history',
      "HISTSIZE=1000",
      "SAVEHIST=1000",
      "setopt INC_APPEND_HISTORY SHARE_HISTORY EXTENDED_HISTORY",
      "export FROM_RC=yes",
      "export ANTHROPIC_BASE_URL=https://real.example",
      "",
    ].join("\n"),
  )
  return { home, history, before: await fs.readFile(history, "utf8") }
}

const typeIntoShell = async (env: Record<string, string>) => {
  const p = Bun.spawn([zsh!, "-i"], {
    env,
    stdin: new TextEncoder().encode("echo typed-into-pane\n"),
    stdout: "ignore",
    stderr: "ignore",
  })
  await p.exited
}

test.if(zsh !== null)("reading the login environment writes nothing to the shell history", async () => {
  const { home, history, before } = await fakeHome()
  const env = capture(home, zsh!)
  expect(env.FROM_RC).toBe("yes")
  expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  expect(env.HISTFILE).toBeUndefined()
  expect(await fs.readFile(history, "utf8")).toBe(before)
})

test.if(zsh !== null)("commands typed into a world's pane shells stay out of the user's history", async () => {
  const { home, history, before } = await fakeHome()
  await typeIntoShell({ HOME: home, PATH: "/usr/bin:/bin" })
  expect(await fs.readFile(history, "utf8")).toContain("typed-into-pane")
  await fs.writeFile(history, before)
  const w = await World.create(capture(home, zsh!), "first-run")
  try {
    const { ZDOTDIR, HISTFILE } = w.env()
    const out = Bun.spawn([zsh!, "-i"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", ZDOTDIR: ZDOTDIR!, HISTFILE: HISTFILE! },
      stdin: new TextEncoder().encode('echo "rc:$FROM_RC"\n'),
      stdout: "pipe",
      stderr: "ignore",
    })
    expect(await new Response(out.stdout).text()).toContain("rc:yes")
    expect(await fs.readFile(history, "utf8")).toBe(before)
    expect(await fs.readFile(path.join(ZDOTDIR!, ".zsh_history"), "utf8")).toContain('echo "rc:$FROM_RC"')
  } finally {
    await w.close()
    await fs.rm(w.root, { recursive: true, force: true })
  }
})

test("the history invariant names a history file that holds a command from this run's worlds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vbe-hist-test-"))
  const mine = path.join(dir, ".zsh_history")
  const other = path.join(dir, ".bash_history")
  await fs.writeFile(mine, ": 1:0;pi --append-system-prompt /tmp/vbe-AbC123/tmp/x\n")
  await fs.writeFile(other, "ls /tmp/vbe-Other1\n")
  expect(await historyNaming(["/tmp/vbe-AbC123", "/private/tmp/vbe-Zz9"], [mine, other])).toEqual([mine])
})
