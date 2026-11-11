import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import url from "node:url"

export const reapFile = (pid = process.pid) => path.join(os.tmpdir(), `vibest-reap-${pid}`)

export const commandOf = (pid: number) =>
  childProcess.spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? ""

const startedAt = (pid: number) =>
  childProcess.spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).stdout.trim()

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

export const note = (pid: number | undefined, marker: string, scope = "", children = "") => {
  const file = process.env.VIBEST_REAP_FILE
  if (file === undefined || pid === undefined || !Number.isInteger(pid) || pid <= 1) return
  if (marker === "" || [marker, scope, children].some((field) => /[\t\n]/.test(field))) return
  const started = startedAt(pid)
  if (started === "" || started.includes("\t") || started.includes("\n")) return
  fs.appendFileSync(file, `${pid}\t${marker}\t${scope}\t${started}\t${children}\n`)
}

type Row = { pid: number; marker: string; scope: string; started: string; children: string }

const rows = (file: string, scope?: string) => {
  let text = ""
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  const found: Array<Row> = []
  for (const line of text.split("\n")) {
    if (line === "") continue
    const [pidText, marker, rowScope = "", started = "", children = ""] = line.split("\t")
    const pid = Number(pidText)
    if (marker === undefined || marker === "" || started === "" || !Number.isInteger(pid) || pid <= 1) continue
    if (scope !== undefined && rowScope !== scope) continue
    found.push({ pid, marker, scope: rowScope, started, children })
  }
  return found
}

const stillTheSame = (row: { pid: number; marker: string; started: string }) =>
  alive(row.pid) && commandOf(row.pid).includes(row.marker) && startedAt(row.pid) === row.started

const childrenOf = (parent: number, marker: string) =>
  childProcess
    .spawnSync("ps", ["-A", "-o", "pid=,ppid=,lstart=,command="], { encoding: "utf8" })
    .stdout.split("\n")
    .flatMap((line) => {
      const [, pid, ppid, started, command] =
        /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} +\d+ [\d:]+ \d{4})\s+(.*)$/.exec(line) ?? []
      return Number(ppid) === parent && started !== undefined && command !== undefined && command.includes(marker)
        ? [{ pid: Number(pid), started, command: command.trim() }]
        : []
    })

export const noteChildren = (file: string) => {
  const known = rows(file)
  for (const row of known) {
    if (row.children === "" || !stillTheSame(row)) continue
    for (const child of childrenOf(row.pid, row.children))
      if (!/[\t\n]/.test(child.command) && !known.some((k) => k.pid === child.pid && k.started === child.started))
        fs.appendFileSync(file, `${child.pid}\t${child.command}\t${row.scope}\t${child.started}\t\n`)
  }
}

const owned = (file: string, scope?: string) => {
  const seen = new Set<number>()
  const found: Array<{ pid: number; marker: string; started: string; command: string }> = []
  for (const row of rows(file, scope)) {
    if (seen.has(row.pid) || !stillTheSame(row)) continue
    seen.add(row.pid)
    found.push({ ...row, command: commandOf(row.pid).trim() })
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
  noteChildren(file)
  for (const row of owned(file, scope)) {
    if (!stillTheSame(row)) continue
    signal(row.pid, "SIGTERM")
    await waitDead(row.pid, 2_000)
    if (!stillTheSame(row)) continue
    signal(row.pid, "SIGKILL")
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
  while (alive(parent)) {
    noteChildren(file)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  await endNoted(file)
}

const ownerPid = (name: string) => /^vibest-reap-(?:e2e-)?(\d+)$/.exec(name)?.[1]

const runEnded = (owner: number, file: string) => {
  if (!alive(owner)) return true
  const ownerStarted = Date.parse(startedAt(owner))
  const fileCreated = fs.statSync(file, { throwIfNoEntry: false })?.birthtimeMs
  return fileCreated !== undefined && ownerStarted > fileCreated + 1_000
}

export const reapEndedRuns = async (dir = os.tmpdir()) => {
  for (const name of fs.readdirSync(dir)) {
    const owner = ownerPid(name)
    const file = path.join(dir, name)
    if (
      owner === undefined ||
      fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() !== true ||
      !runEnded(Number(owner), file)
    )
      continue
    await endNoted(file)
    fs.rmSync(file, { force: true })
  }
}

if (import.meta.main && process.argv[2] === "--watch") {
  await watch(Number(process.argv[3]), process.argv[4] ?? "")
}
