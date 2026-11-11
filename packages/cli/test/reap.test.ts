import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, it } from "@effect/vitest"

import { alive, endNoted, note, reapEndedRuns, survivors } from "../../../tools/reap.ts"

it("a process this run noted is still alive afterwards: the run reports it and it is killed; a different command at that pid is not", async () => {
  const file = path.join(os.tmpdir(), `vibest-reap-test-${process.pid}-${Date.now()}`)
  const saved = process.env.VIBEST_REAP_FILE
  process.env.VIBEST_REAP_FILE = file
  fs.writeFileSync(file, "")
  const owned = childProcess.spawn("sleep", ["30"], { stdio: "ignore" })
  const other = childProcess.spawn("sleep", ["30"], { stdio: "ignore" })
  try {
    note(owned.pid, "sleep 30")
    note(other.pid, "not-this-command")
    fs.appendFileSync(file, `${owned.pid}\tsleep 30\t\tnot-the-start-time\n`)
    const left = survivors(file)
    assert.strictEqual(left.length, 1)
    assert.include(left[0], "sleep 30")
    fs.writeFileSync(file, `${owned.pid}\tsleep 30\t\tnot-the-start-time\n`)
    assert.deepStrictEqual(survivors(file), [])
    note(owned.pid, "sleep 30")
    await endNoted(file)
    assert.deepStrictEqual(survivors(file), [])
    assert.isTrue(owned.pid !== undefined && !alive(owned.pid))
    assert.isTrue(other.pid !== undefined && alive(other.pid))
  } finally {
    for (const child of [owned, other]) if (child.exitCode === null) child.kill("SIGKILL")
    fs.rmSync(file, { force: true })
    if (saved === undefined) delete process.env.VIBEST_REAP_FILE
    else process.env.VIBEST_REAP_FILE = saved
  }
})

const killedRun = `
import childProcess from "node:child_process"
import path from "node:path"
import { note } from ${JSON.stringify(path.join(import.meta.dirname, "../../../tools/reap.ts"))}
process.env.VIBEST_REAP_FILE = path.join(process.argv[2], \`vibest-reap-\${process.pid}\`)
const start = (script) => childProcess.spawn("sh", ["-c", script], { detached: true, stdio: "ignore" }).pid
const core = start("sleep 3001 & sleep 3002 & wait")
note(start("exec sleep 3000"), "sleep 3000")
note(core, "sleep 3001 & sleep 3002", "", "sleep 3001")
start("exec sleep 3003")
await new Promise((resolve) => setTimeout(resolve, 300))
console.log(JSON.stringify({ core }))
setInterval(() => {}, 1000)
`

const pidsOf = (pattern: string) =>
  childProcess.spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number)

it("a run killed hard leaves noted processes and its core's noted children behind; the next run stops them, keeps everything not noted, and keeps a live run's file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-reap-dir-"))
  const script = path.join(dir, "run.ts")
  fs.writeFileSync(script, killedRun)
  const saved = process.env.VIBEST_REAP_FILE
  const liveRun = path.join(dir, `vibest-reap-${process.pid}`)
  const liveOwned = childProcess.spawn("sleep", ["3004"], { stdio: "ignore" })
  try {
    process.env.VIBEST_REAP_FILE = liveRun
    note(liveOwned.pid, "sleep 3004")
    const run = childProcess.spawn(process.execPath, [script, dir], { stdio: ["ignore", "pipe", "inherit"] })
    const file = path.join(dir, `vibest-reap-${run.pid}`)
    const ready = await new Promise<string>((resolve) => run.stdout.once("data", (chunk) => resolve(String(chunk))))
    assert.include(ready, "core")
    run.kill("SIGKILL")
    await new Promise((resolve) => run.once("exit", resolve))
    for (const left of ["^sleep 3000$", "^sh -c sleep 3001", "^sleep 3001$", "^sleep 3002$", "^sleep 3003$"])
      assert.lengthOf(pidsOf(left), 1, `${left} outlived its run`)

    await reapEndedRuns(dir)

    for (const stopped of ["^sleep 3000$", "^sh -c sleep 3001", "^sleep 3001$"])
      assert.deepStrictEqual(pidsOf(stopped), [], `${stopped} was not stopped`)
    assert.lengthOf(pidsOf("^sleep 3002$"), 1, "a child the core's row does not name was stopped")
    assert.lengthOf(pidsOf("^sleep 3003$"), 1, "a process no row names was stopped")
    assert.isFalse(fs.existsSync(file))
    assert.isTrue(fs.existsSync(liveRun))
    assert.isTrue(liveOwned.pid !== undefined && alive(liveOwned.pid))
  } finally {
    for (const pid of pidsOf("^(sh -c )?sleep 300[0-3]")) process.kill(pid, "SIGKILL")
    liveOwned.kill("SIGKILL")
    fs.rmSync(dir, { recursive: true, force: true })
    if (saved === undefined) delete process.env.VIBEST_REAP_FILE
    else process.env.VIBEST_REAP_FILE = saved
  }
})
