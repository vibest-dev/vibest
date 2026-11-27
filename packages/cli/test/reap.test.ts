import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, it } from "@effect/vitest"
import { runVibest } from "@vibest/testkit/fakes"
import { Effect } from "effect"

import * as Platform from "#platform"

import { alive, endNoted, note, reapEndedRuns } from "../../../tools/reap.ts"

const noteIn = (file: string, pid: number | undefined, marker: string) => {
  const saved = process.env.VIBEST_REAP_FILE
  process.env.VIBEST_REAP_FILE = file
  note(pid, marker)

  if (saved === undefined) delete process.env.VIBEST_REAP_FILE
  else process.env.VIBEST_REAP_FILE = saved
}

it("cleanup of an ended run stops only the processes it recorded: not a reused pid, not a live run's process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-reap-dir-"))
  const ended = path.join(dir, "vibest-reap-999999999")
  const live = path.join(dir, `vibest-reap-${process.pid}`)
  const sleep = () => childProcess.spawn("sleep", ["60"], { stdio: "ignore" })
  const recorded = sleep()
  const reused = sleep()
  const restarted = sleep()
  const liveOwned = sleep()

  try {
    noteIn(ended, recorded.pid, "sleep 60")
    noteIn(ended, reused.pid, "another-command")
    fs.appendFileSync(ended, `${restarted.pid}\tsleep 60\t\tnot-its-start-time\t\n`)
    noteIn(live, liveOwned.pid, "sleep 60")

    await reapEndedRuns(dir)

    assert.isFalse(alive(recorded.pid!), "the recorded process was not stopped")
    assert.isTrue(alive(reused.pid!), "a pid now running another command was stopped")
    assert.isTrue(alive(restarted.pid!), "a pid started after the record was stopped")
    assert.isTrue(alive(liveOwned.pid!), "a live run's process was stopped")
    assert.isFalse(fs.existsSync(ended))
    assert.isTrue(fs.existsSync(live))
  } finally {
    for (const child of [recorded, reused, restarted, liveOwned]) child.kill("SIGKILL")
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it("runVibest forwards VIBEST_REAP_FILE and BUN_OPTIONS so spawned children and detached daemons are noted and reaped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-reap-forward-"))
  const home = path.join(dir, "home")
  const vibestHome = path.join(dir, "vibest")
  const reapPath = path.join(dir, "reap-file")
  fs.mkdirSync(home, { recursive: true })
  const savedReap = process.env.VIBEST_REAP_FILE
  const savedBunOptions = process.env.BUN_OPTIONS
  const preload = `--preload=${path.resolve(import.meta.dirname, "../../../tools/reap-preload.ts")}`
  let daemonPid: number | undefined

  const killBestEffort = (pid: number) => {
    try {
      process.kill(pid, "SIGKILL")
    } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || e.code !== "ESRCH") throw e
    }
  }

  try {
    process.env.VIBEST_REAP_FILE = reapPath
    process.env.BUN_OPTIONS = [savedBunOptions, preload].filter(Boolean).join(" ")

    const versionResult = await Effect.runPromise(
      runVibest(home, { HOME: home }, ["--version"]).pipe(Effect.provide(Platform.services)),
    )

    assert.strictEqual(versionResult.code, 0)
    const afterVersion = fs.readFileSync(reapPath, "utf8")
    assert.include(afterVersion, "--version")

    const daemonResult = await Effect.runPromise(
      runVibest(home, { HOME: home, VIBEST_HOME: vibestHome }, ["daemon"]).pipe(Effect.provide(Platform.services)),
    )

    assert.strictEqual(daemonResult.code, 0)
    const info = JSON.parse(fs.readFileSync(path.join(vibestHome, "vibestd.pid"), "utf8")) as { pid?: number }
    daemonPid = info.pid
    assert.isNumber(daemonPid)
    assert.isTrue(alive(daemonPid!))
    assert.include(fs.readFileSync(reapPath, "utf8"), `${daemonPid}\t`)

    await endNoted(reapPath)
    assert.isFalse(alive(daemonPid!))
  } finally {
    if (savedReap === undefined) delete process.env.VIBEST_REAP_FILE
    else process.env.VIBEST_REAP_FILE = savedReap

    if (savedBunOptions === undefined) delete process.env.BUN_OPTIONS
    else process.env.BUN_OPTIONS = savedBunOptions

    if (daemonPid !== undefined && alive(daemonPid)) killBestEffort(daemonPid)

    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
