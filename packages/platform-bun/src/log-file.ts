import fs from "node:fs"

export const LOG_MAX_BYTES = 10 * 1024 * 1024
export const LOG_KEEP_BYTES = 5 * 1024 * 1024

const CHUNK = 64 * 1024

const isEnoent = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT"

const lineStart = (fd: number, from: number, size: number) => {
  const chunk = Buffer.alloc(Math.min(CHUNK, Math.max(size - from, 1)))
  let cursor = from
  while (cursor < size) {
    const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - cursor), cursor)
    if (n <= 0) return from
    const newline = chunk.subarray(0, n).indexOf(10)
    if (newline !== -1) return cursor + newline + 1
    cursor += n
  }
  return from
}

export const trimLog = (file: string, limits?: { readonly max?: number; readonly keep?: number }) => {
  const max = limits?.max ?? LOG_MAX_BYTES
  const keep = limits?.keep ?? LOG_KEEP_BYTES
  let size: number
  try {
    size = fs.statSync(file).size
  } catch (e) {
    if (isEnoent(e)) return
    throw e
  }
  if (size <= max) return
  const fd = fs.openSync(file, "r+")
  try {
    const cut = lineStart(fd, Math.max(0, size - keep), size)
    const length = size - cut
    const kept = Buffer.alloc(length)
    const n = length === 0 ? 0 : fs.readSync(fd, kept, 0, length, cut)
    fs.ftruncateSync(fd, 0)
    if (n > 0) fs.writeSync(fd, kept, 0, n, 0)
  } finally {
    fs.closeSync(fd)
  }
}
