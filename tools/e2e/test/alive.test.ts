import { expect, test } from "bun:test"

import { alive } from "../src/world.ts"

test("a zombie of a niced parent (ps state ZN, as a loaded macOS shows an exited vibestd) is not alive", async () => {
  const parent = Bun.spawn(
    ["nice", "-n", "5", "perl", "-e", '$|=1; my $p = fork(); if ($p == 0) { exit 0 } print "$p\\n"; sleep 10'],
    {
      stdout: "pipe",
    },
  )
  try {
    const reader = parent.stdout.getReader()
    const child = Number(new TextDecoder().decode((await reader.read()).value).trim())
    let state = ""
    for (let i = 0; i < 50 && !state.startsWith("Z"); i++) {
      await Bun.sleep(20)
      state = Bun.spawnSync(["ps", "-p", String(child), "-o", "state="])
        .stdout.toString()
        .trim()
    }
    expect(state).toStartWith("Z")
    expect(alive(child)).toBe(false)
    expect(alive(parent.pid)).toBe(true)
  } finally {
    parent.kill()
  }
})
