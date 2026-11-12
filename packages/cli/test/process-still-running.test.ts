import { assert, describe, it } from "@effect/vitest"
import { processStillRunning } from "@vibest/runtime-herdr/terminal-runtime"

const shell = { shell_pid: 10, foreground_processes: [{ pid: 10 }] }

describe("process: a shell that has not started its agent is not an exited terminal", () => {
  it("a pending launch is running even when the foreground is only the shell", () => {
    assert.isTrue(processStillRunning(shell, true))
  })
})
