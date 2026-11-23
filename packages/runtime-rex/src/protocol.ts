import crypto from "node:crypto"

export const SUBPROTOCOL = "rex.control.v1"

export const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const

export interface Message {
  readonly opcode: number
  readonly data: Uint8Array
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  if (a.length === 0) return b

  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)

  return out
}

export const encodeFrame = (opcode: number, payload: Uint8Array, mask: Uint8Array = crypto.randomBytes(4)) => {
  const length = payload.length
  const extra = length < 126 ? 0 : length < 65_536 ? 2 : 8
  const frame = new Uint8Array(2 + extra + 4 + length)
  const view = new DataView(frame.buffer)
  frame[0] = 0x80 | opcode

  if (extra === 0) frame[1] = 0x80 | length
  else if (extra === 2) {
    frame[1] = 0x80 | 126
    view.setUint16(2, length)
  } else {
    frame[1] = 0x80 | 127
    view.setBigUint64(2, BigInt(length))
  }

  const at = 2 + extra
  frame.set(mask.subarray(0, 4), at)

  for (let i = 0; i < length; i++) frame[at + 4 + i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)

  return frame
}

export const encodeText = (text: string, mask?: Uint8Array) =>
  encodeFrame(OPCODE.text, new TextEncoder().encode(text), mask)

interface Frame {
  readonly fin: boolean
  readonly opcode: number
  readonly payload: Uint8Array
}

const EXTENDED_LENGTH_BYTES = new Map([
  [126, 2],
  [127, 8],
])

const payloadLength = (view: DataView, short: number, extra: number) => {
  if (extra === 2) return view.getUint16(2)

  if (extra === 8) return Number(view.getBigUint64(2))

  return short
}

const frameAt = (buffer: Uint8Array): { readonly frame: Frame; readonly size: number } | undefined => {
  if (buffer.length < 2) return undefined
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const first = buffer[0] ?? 0
  const second = buffer[1] ?? 0
  const masked = (second & 0x80) !== 0
  const short = second & 0x7f
  const extra = EXTENDED_LENGTH_BYTES.get(short) ?? 0

  if (buffer.length < 2 + extra) return undefined
  const length = payloadLength(view, short, extra)
  const start = 2 + extra + (masked ? 4 : 0)

  if (buffer.length < start + length) return undefined
  const payload = buffer.slice(start, start + length)

  if (masked) for (let i = 0; i < length; i++) payload[i] = (payload[i] ?? 0) ^ (buffer[start - 4 + (i % 4)] ?? 0)

  return { frame: { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload }, size: start + length }
}

export const messageReader = () => {
  let buffer: Uint8Array = new Uint8Array(0)
  let fragments: { opcode: number; data: Uint8Array } | undefined

  return (chunk: Uint8Array): ReadonlyArray<Message> => {
    buffer = concat(buffer, chunk)
    const messages: Array<Message> = []

    for (let next = frameAt(buffer); next !== undefined; next = frameAt(buffer)) {
      buffer = buffer.subarray(next.size)
      const { fin, opcode, payload } = next.frame

      if (opcode >= OPCODE.close) {
        messages.push({ opcode, data: payload })
        continue
      }

      const whole =
        opcode === OPCODE.continuation && fragments !== undefined
          ? { opcode: fragments.opcode, data: concat(fragments.data, payload) }
          : { opcode, data: payload }

      if (fin) {
        fragments = undefined
        messages.push(whole)
      } else fragments = whole
    }

    return messages
  }
}

export const handshakeKey = () => crypto.randomBytes(16).toString("base64")

export const upgradeRequest = (key: string) =>
  [
    "GET /api/control HTTP/1.1",
    "Host: localhost",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Protocol: ${SUBPROTOCOL}`,
    "",
    "",
  ].join("\r\n")

const acceptOf = (key: string) =>
  crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")

const HEAD_END = new TextEncoder().encode("\r\n\r\n")

const indexOfHeadEnd = (buffer: Uint8Array) => {
  for (let i = 0; i + 3 < buffer.length; i++) if (HEAD_END.every((byte, j) => buffer[i + j] === byte)) return i

  return -1
}

export type Upgrade =
  | { readonly status: "partial" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "accepted"; readonly rest: Uint8Array }

export const readUpgrade = (buffer: Uint8Array, key: string): Upgrade => {
  const end = indexOfHeadEnd(buffer)

  if (end < 0) return { status: "partial" }
  const [statusLine = "", ...headers] = new TextDecoder().decode(buffer.subarray(0, end)).split("\r\n")

  if (!/^HTTP\/1\.1 101\b/.test(statusLine)) return { status: "refused", reason: statusLine }

  const header = (name: string) =>
    headers
      .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
      ?.slice(name.length + 1)
      .trim()

  if (header("Sec-WebSocket-Accept") !== acceptOf(key))
    return { status: "refused", reason: "the server answered with a wrong Sec-WebSocket-Accept" }

  return { status: "accepted", rest: buffer.slice(end + HEAD_END.length) }
}
