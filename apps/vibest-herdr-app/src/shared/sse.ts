import { Buffer } from "buffer"

import type { WatchFrame } from "./watch-state.ts"

const HEAD_END = [13, 10, 13, 10]
const BLOCK_END = [10, 10]

const find = (bytes: Uint8Array, needle: readonly number[]): number => {
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (needle.every((b, j) => bytes[i + j] === b)) return i
  }

  return -1
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes.slice()).toString("utf8")

const frame = (block: string): WatchFrame | null => {
  let event = "message"
  const data: string[] = []

  for (const line of block.replaceAll("\r", "").split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }

  if (data.length === 0) return null

  const body = data.join("\n")

  if (event === "message") {
    try {
      return { result: [JSON.parse(body)] }
    } catch {
      throw new Error(`DBG ${body.length} [${body.slice(0, 30)}] [${body.slice(-30)}]`)
    }
  }

  const error = (() => {
    try {
      return JSON.parse(body)
    } catch {
      return { message: body }
    }
  })()

  return { error: { _tag: error?._tag ?? event, message: error?.message } }
}

export class SseResponse {
  status = 0
  private pending = new Uint8Array(0)

  push(bytes: Uint8Array): WatchFrame[] {
    const joined = new Uint8Array(this.pending.length + bytes.length)

    joined.set(this.pending)
    joined.set(bytes, this.pending.length)
    this.pending = joined

    if (this.status === 0) {
      const end = find(this.pending, HEAD_END)

      if (end < 0) return []

      this.status = Number(text(this.pending.subarray(0, end)).split(" ")[1]) || -1
      this.pending = this.pending.subarray(end + HEAD_END.length)
    }

    if (this.status !== 200) return []

    const frames: WatchFrame[] = []

    for (let end = find(this.pending, BLOCK_END); end >= 0; end = find(this.pending, BLOCK_END)) {
      const next = frame(text(this.pending.subarray(0, end)))

      this.pending = this.pending.subarray(end + BLOCK_END.length)

      if (next) frames.push(next)
    }

    return frames
  }

  refusal(): string {
    const body = text(this.pending)

    try {
      return JSON.parse(body).message ?? `vibestd answered ${this.status}`
    } catch {
      return `vibestd answered ${this.status}`
    }
  }
}
