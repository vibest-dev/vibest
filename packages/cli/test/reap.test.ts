import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, it } from "@effect/vitest"

import { alive, commandOf, endNoted, note, reapEndedRuns, survivors } from "../../../tools/reap.ts"

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
import { commandOf, note, noteChildren } from ${JSON.stringify(path.join(import.meta.dirname, "../../../tools/reap.ts"))}
const file = path.join(process.argv[2], \`vibest-reap-\${process.pid}\`)
process.env.VIBEST_REAP_FILE = file
const n = Number(process.argv[3])
const start = (script) => childProcess.spawn("sh", ["-c", script], { detached: true, stdio: "ignore" }).pid
const noted = start(\`exec sleep \${n}\`)
const leader = start(\`trap "" TERM; sleep \${n + 1} & sleep \${n + 2} & wait\`)
const core = start(\`sleep \${n + 3} & wait\`)
const stranger = start(\`exec sleep \${n + 4}\`)
await new Promise((resolve) => setTimeout(resolve, 300))
note(noted, commandOf(noted).trim())
note(leader, commandOf(leader).trim(), "", \`sleep \${n + 1}\`)
note(core, commandOf(core).trim(), "", \`sleep \${n + 3}\`)
noteChildren(file)
console.log(JSON.stringify({ noted, leader, core, stranger }))
setInterval(() => {}, 1000)
`

const childOf = (parent: number, command: string) =>
  childProcess
    .spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number)
    .find((pid) => commandOf(pid).trim() === command)

it("a run killed hard leaves its processes behind; the next run stops each recorded one by itself (not its group), a recorded child even after its core died, and nothing unrecorded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-reap-dir-"))
  const script = path.join(dir, "run.ts")
  fs.writeFileSync(script, killedRun)
  fs.mkdirSync(path.join(dir, "vibest-reap-999999999"))
  const n = 40_000 + Math.floor(Math.random() * 50_000)
  const saved = process.env.VIBEST_REAP_FILE
  const liveRun = path.join(dir, `vibest-reap-${process.pid}`)
  const liveOwned = childProcess.spawn("sleep", [String(n + 5)], { stdio: "ignore" })
  const fixtureCleanup = path.join(dir, "fixture-cleanup")
  try {
    process.env.VIBEST_REAP_FILE = liveRun
    note(liveOwned.pid, `sleep ${n + 5}`)
    const run = childProcess.spawn(process.execPath, [script, dir, String(n)], { stdio: ["ignore", "pipe", "inherit"] })
    const file = path.join(dir, `vibest-reap-${run.pid}`)
    const ready = await new Promise<string>((resolve) => run.stdout.once("data", (chunk) => resolve(String(chunk))))
    const { noted, leader, core, stranger } = JSON.parse(ready) as Record<string, number>
    const leaderNamed = childOf(leader!, `sleep ${n + 1}`)
    const leaderUnnamed = childOf(leader!, `sleep ${n + 2}`)
    const coreChild = childOf(core!, `sleep ${n + 3}`)
    const fixture = [noted, leader, core, stranger, leaderNamed, leaderUnnamed, coreChild]
    assert.isTrue(fixture.every((pid) => pid !== undefined && alive(pid)))
    process.env.VIBEST_REAP_FILE = fixtureCleanup
    for (const pid of fixture) note(pid, commandOf(pid!).trim())
    process.env.VIBEST_REAP_FILE = liveRun
    run.kill("SIGKILL")
    process.kill(core!, "SIGKILL")
    await new Promise((resolve) => run.once("exit", resolve))
    while (alive(core!)) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.isTrue(alive(coreChild!), "the core's child outlives the core")

    await reapEndedRuns(dir)

    for (const [what, pid] of Object.entries({ noted, leader, leaderNamed, coreChild }))
      assert.isFalse(alive(pid!), `${what} was not stopped`)
    assert.isTrue(alive(leaderUnnamed!), "an unrecorded member of a recorded leader's group was stopped")
    assert.isTrue(alive(stranger!), "a process no row names was stopped")
    assert.isFalse(fs.existsSync(file))
    assert.isTrue(fs.existsSync(liveRun))
    assert.isTrue(liveOwned.pid !== undefined && alive(liveOwned.pid))
  } finally {
    await endNoted(fixtureCleanup)
    liveOwned.kill("SIGKILL")
    fs.rmSync(dir, { recursive: true, force: true })
    if (saved === undefined) delete process.env.VIBEST_REAP_FILE
    else process.env.VIBEST_REAP_FILE = saved
  }
})
