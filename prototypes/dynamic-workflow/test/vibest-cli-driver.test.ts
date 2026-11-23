import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { VibestCliDriver } from "../src/vibest-cli-driver.ts"

const FAKE_CLI = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$(dirname "$0")/calls"',
  'case "$1" in',
  '  run) echo \'{"id":"w1"}\' ;;',
  '  send) echo \'{"id":"w1","queued":true}\' ;;',
  '  result) cat "$(dirname "$0")/result.json" ;;',
  "  *) echo null ;;",
  "esac",
].join("\n")

const fakeCli = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-vibest-"))
  const bin = path.join(dir, "vibest")
  await Bun.write(bin, FAKE_CLI)
  await fs.chmod(bin, 0o755)

  const result = (value: string) => Bun.write(path.join(dir, "result.json"), value)

  const calls = async () => (await Bun.file(path.join(dir, "calls")).text()).trim().split("\n")

  return { bin, result, calls }
}

const reply = (execution: number, status: string, text: string | null, failure: string | null) =>
  JSON.stringify({ status: "idle", reply: { execution, status, text, failure, endedAt: 1 } })

describe("VibestCliDriver", () => {
  test("starts a session with vibest run and waits for a reply newer than the last one", async () => {
    const cli = await fakeCli()
    const driver = new VibestCliDriver(cli.bin, 5)
    await cli.result(JSON.stringify({ status: "working", reply: null }))

    const id = await driver.spawn({ title: "Audit core", prompt: "-look", harness: "pi", model: "grok" })
    const waiting = driver.reply(id, 0, new AbortController().signal)
    await Bun.sleep(30)
    await cli.result(reply(1, "completed", "all good", null))

    expect(id).toBe("w1")
    expect(await waiting).toEqual({ execution: 1, outcome: "completed", text: "all good", failure: undefined })
    expect((await cli.calls())[0]).toBe("run pi --title Audit core --model grok -- -look")
  })

  test("reads a usage limit failure and a permission wait as escalations", async () => {
    const cli = await fakeCli()
    const driver = new VibestCliDriver(cli.bin, 5)
    await cli.result(reply(2, "failed", null, "usage limit reached: resets at 5pm"))

    expect((await driver.reply("w1", 1, new AbortController().signal)).outcome).toBe("limit")
    await cli.result(JSON.stringify({ status: "blocked", reply: null }))
    expect((await driver.reply("w1", 2, new AbortController().signal)).outcome).toBe("blocked")
  })

  test("the cli runs a workflow end to end and exits with its status", async () => {
    const cli = await fakeCli()
    const dir = path.dirname(cli.bin)
    const script = path.join(dir, "one.ts")
    await Bun.write(script, 'export default (wf) => wf.agent({ title: "Say hi", prompt: "hi" })\n')
    await cli.result(reply(1, "completed", "hi there", null))

    const run = Bun.spawn(["bun", path.join(import.meta.dir, "../src/cli.ts"), "run", script], {
      env: { ...Bun.env, VIBEST_CLI: cli.bin },
      stdout: "pipe",
      stderr: "pipe",
    })

    const out = await new Response(run.stdout).text()

    expect(await run.exited).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ status: "completed", result: "hi there" })
    const calls = await cli.calls()

    expect(calls[0]).toStartWith("run --title Say hi -- You are one step of a vibest workflow.")
    expect(calls.slice(-3)).toEqual(["hi", "result w1", "archive w1"])
  })
})
