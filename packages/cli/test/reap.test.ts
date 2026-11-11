import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, it } from "@effect/vitest"

import { alive, endNoted, note, survivors } from "../../../tools/reap.ts"

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
