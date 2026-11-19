import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assert, it } from "@effect/vitest"

import { alive, note, reapEndedRuns } from "../../../tools/reap.ts"

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
