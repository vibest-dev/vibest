import { Schema } from "effect"

export const PIPE_MAGIC = new TextEncoder().encode("VBHTTP01")

export const FRAME_REQ_HEAD = 1
export const FRAME_REQ_DATA = 2
export const FRAME_REQ_END = 3
export const FRAME_RES_HEAD = 4
export const FRAME_RES_DATA = 5
export const FRAME_RES_END = 6
export const FRAME_RST = 7
export const FRAME_PING = 8
export const FRAME_PONG = 9

export const HEADER_BYTES = 9

export class PipeIncompatible extends Schema.TaggedError<PipeIncompatible>()("PipeIncompatible", {
  message: Schema.String,
}) {}

export interface PipeFrame {
  readonly type: number
  readonly streamId: number
  readonly payload: Uint8Array
}

export const ReqHeadSchema = Schema.fromJsonString(
  Schema.Struct({
    method: Schema.String,
    path: Schema.String,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  }),
)

export const ResHeadSchema = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Number,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  }),
)

export const encodeFrame = (type: number, streamId: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array => {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, HEADER_BYTES)
  view.setUint8(0, type)
  view.setUint32(1, streamId, false)
  view.setUint32(5, payload.byteLength, false)
  out.set(payload, HEADER_BYTES)

  return out
}

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.byteLength === 0) return b

  if (b.byteLength === 0) return a
  const merged = new Uint8Array(a.byteLength + b.byteLength)
  merged.set(a, 0)
  merged.set(b, a.byteLength)

  return merged
}

export type FramePushResult = {
  readonly magic: "pending" | "ok" | "mismatch"
  readonly frames: ReadonlyArray<PipeFrame>
}

export class FrameParser {
  private buffer: Uint8Array = new Uint8Array(0)
  private magicChecked = false

  push(chunk: Uint8Array): FramePushResult {
    this.buffer = concatBytes(this.buffer, chunk)

    if (!this.magicChecked) {
      const checkLen = Math.min(this.buffer.byteLength, PIPE_MAGIC.byteLength)

      for (let i = 0; i < checkLen; i++) {
        if (this.buffer[i] !== PIPE_MAGIC[i]) return { magic: "mismatch", frames: [] }
      }

      if (this.buffer.byteLength < PIPE_MAGIC.byteLength) return { magic: "pending", frames: [] }
      this.buffer = this.buffer.subarray(PIPE_MAGIC.byteLength)
      this.magicChecked = true
    }

    const frames: Array<PipeFrame> = []

    while (this.buffer.byteLength >= HEADER_BYTES) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, HEADER_BYTES)
      const type = view.getUint8(0)
      const streamId = view.getUint32(1, false)
      const length = view.getUint32(5, false)

      if (this.buffer.byteLength < HEADER_BYTES + length) break
      const payload = this.buffer.slice(HEADER_BYTES, HEADER_BYTES + length)
      this.buffer = this.buffer.subarray(HEADER_BYTES + length)
      frames.push({ type, streamId, payload })
    }

    return { magic: "ok", frames }
  }
}
