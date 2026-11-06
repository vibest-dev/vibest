import { dlopen, FFIType, ptr } from "bun:ffi"
import fs from "node:fs/promises"

import { type ProcessFacts } from "@vibest/core/processes"

const mac =
  process.platform === "darwin"
    ? dlopen("libproc.dylib", {
        proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
        getsid: { args: [FFIType.i32], returns: FFIType.i32 },
      })
    : undefined

export const linuxFacts = (pid: number, stat: string, namespace: string): ProcessFacts | undefined => {
  const end = stat.lastIndexOf(")")
  if (end < 0 || Number(stat.slice(0, stat.indexOf(" "))) !== pid) return undefined
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/)
  if (fields.length < 20 || fields[0] === "Z" || fields[0] === "X") return undefined
  const parent = Number(fields[1])
  const session = Number(fields[3])
  const tty = Number(fields[4])
  if (![parent, session, tty].every(Number.isInteger) || !/^\d+$/.test(fields[19]!)) return undefined
  return {
    pid,
    parent,
    session: session > 0 ? String(session) : undefined,
    tty: tty === 0 ? undefined : String(tty),
    start: fields[19]!,
    namespace,
  }
}

export const inspect = async (pid: number): Promise<ProcessFacts | undefined> => {
  try {
    if (mac) {
      const bytes = new Uint8Array(136)
      if (mac.symbols.proc_pidinfo(pid, 3, 0, ptr(bytes), bytes.length) !== bytes.length) return undefined
      const info = new DataView(bytes.buffer)
      if (info.getUint32(12, true) !== pid || info.getUint32(4, true) === 5) return undefined
      const tty = info.getUint32(108, true)
      const session = mac.symbols.getsid(pid)
      return {
        pid,
        parent: info.getUint32(16, true),
        session: session > 0 ? String(session) : undefined,
        tty: tty === 0xffffffff ? undefined : String(tty),
        start: `${info.getBigUint64(120, true)}:${info.getBigUint64(128, true)}`,
        namespace: "local",
      }
    }
    if (process.platform !== "linux") return undefined
    const [stat, namespace, mount] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readlink(`/proc/${pid}/ns/pid`),
      fs.readlink(`/proc/${pid}/ns/mnt`),
    ])
    return linuxFacts(pid, stat, namespace + ":" + mount)
  } catch {
    return undefined
  }
}
