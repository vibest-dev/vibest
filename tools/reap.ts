import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import url from "node:url"

export const reapFile = (pid = process.pid) => path.join(os.tmpdir(), `vibest-reap-${pid}`)

export const commandOf = (pid: number) =>
  childProcess.spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? ""

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  const state = childProcess.spawnSync("ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" }).stdout.trim()
  return state !== "" && !state.startsWith("Z")
}

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig)
  } catch (e) {
    if (!(e instanceof Error) || !("code" in e) || e.code !== "ESRCH") throw e
  }
}

export const note = (pid: number | undefined, marker: string, scope = "") => {
  const file = process.env.VIBEST_REAP_FILE
  if (file === undefined || pid === undefined || !Number.isInteger(pid) || pid <= 1) return
  if (marker === "" || /[\t\n]/.test(marker) || /[\t\n]/.test(scope)) return
  fs.appendFileSync(file, `${pid}\t${marker}\t${scope}\n`)
}

const rows = (file: string, scope?: string) => {
  let text = ""
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  const found: Array<{ pid: number; marker: string }> = []
  for (const line of text.split("\n")) {
    if (line === "") continue
    const [pidText, marker, rowScope = ""] = line.split("\t")
    const pid = Number(pidText)
    if (marker === undefined || marker === "" || !Number.isInteger(pid) || pid <= 1) continue
    if (scope !== undefined && rowScope !== scope) continue
    found.push({ pid, marker })
  }
  return found
}

const owned = (file: string, scope?: string) => {
  const seen = new Set<number>()
  const found: Array<{ pid: number; command: string }> = []
  for (const row of rows(file, scope)) {
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    const command = commandOf(row.pid)
    if (command === "" || !command.includes(row.marker) || !alive(row.pid)) continue
    found.push({ pid: row.pid, command: command.trim() })
  }
  return found
}

export const survivors = (file: string, scope?: string) => owned(file, scope).map((row) => row.command)

const waitDead = async (pid: number, ms: number) => {
  for (const deadline = Date.now() + ms; alive(pid) && Date.now() < deadline;)
    await new Promise((resolve) => setTimeout(resolve, 50))
}

export const endOwned = (pid: number | undefined, marker: string) => {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return
  const command = commandOf(pid)
  if (command === "" || !command.includes(marker)) return
  const group = Number(
    childProcess.spawnSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8" }).stdout.trim(),
  )
  if (group === pid) signal(-pid, "SIGKILL")
  else signal(pid, "SIGKILL")
}

export const endNoted = async (file: string, scope?: string) => {
  for (const row of owned(file, scope)) {
    signal(row.pid, "SIGTERM")
    await waitDead(row.pid, 2_000)
    if (!alive(row.pid)) continue
    endOwned(row.pid, row.command)
    await waitDead(row.pid, 1_000)
  }
}

export const startWatch = (parent: number, file: string) => {
  const child = childProcess.spawn(
    process.execPath,
    [url.fileURLToPath(import.meta.url), "--watch", String(parent), file],
    { detached: true, stdio: "ignore" },
  )
  child.unref()
}

const watch = async (parent: number, file: string) => {
  while (alive(parent)) await new Promise((resolve) => setTimeout(resolve, 500))
  await endNoted(file)
}

if (process.argv[2] === "--watch") {
  await watch(Number(process.argv[3]), process.argv[4] ?? "")
}
