import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { connect } from "../src/client.ts"
import { encodeFrame, messageReader, OPCODE, readUpgrade } from "../src/protocol.ts"
import { make } from "../src/terminal-runtime.ts"

const serverFrame = (opcode: number, payload: Uint8Array, fin = true) => {
  const length = payload.length

  const head =
    length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, length])
      : length < 65_536
        ? Buffer.from([(fin ? 0x80 : 0) | opcode, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 127]), Buffer.alloc(8)])

  if (length >= 65_536) head.writeBigUInt64BE(BigInt(length), 2)

  return Buffer.concat([head, payload])
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)

describe("rex.control.v1 framing", () => {
  it("decodes masked client frames of every length class, one byte at a time", () => {
    for (const size of [0, 125, 126, 65_535, 65_536, 70_000]) {
      const payload = bytes(size)
      const frame = encodeFrame(OPCODE.text, payload)
      const read = messageReader()
      const messages = []

      for (let i = 0; i < frame.length; i += size > 1000 ? 997 : 1)
        messages.push(...read(frame.subarray(i, i + (size > 1000 ? 997 : 1))))
      assert.strictEqual(messages.length, 1, `size ${size}`)
      assert.deepStrictEqual(messages[0]?.data, payload)
    }
  })

  it("joins a fragmented server message and passes a ping between its fragments", () => {
    const read = messageReader()

    const messages = read(
      Buffer.concat([
        serverFrame(OPCODE.text, Buffer.from("hel"), false),
        serverFrame(OPCODE.ping, Buffer.from("p")),
        serverFrame(OPCODE.continuation, Buffer.from("lo"), true),
      ]),
    )

    assert.deepStrictEqual(
      messages.map((m) => [m.opcode, Buffer.from(m.data).toString()]),
      [
        [OPCODE.ping, "p"],
        [OPCODE.text, "hello"],
      ],
    )
  })

  it("accepts an upgrade only with the matching Sec-WebSocket-Accept and keeps the bytes after it", () => {
    const key = "dGhlIHNhbXBsZSBub25jZQ=="

    const head = (accept: string) =>
      Buffer.from(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\nrest`,
      )

    const accepted = readUpgrade(head("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), key)
    assert.strictEqual(accepted.status, "accepted")

    if (accepted.status === "accepted") assert.strictEqual(Buffer.from(accepted.rest).toString(), "rest")
    assert.strictEqual(readUpgrade(head("wrong"), key).status, "refused")
    assert.strictEqual(readUpgrade(head("x").subarray(0, 20), key).status, "partial")
  })
})

const fakeServer = (revision: number, closeAfterWelcome = false) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly socket: string; readonly server: net.Server; readonly hellos: Array<string> }>(
      (resume) => {
        const hellos: Array<string> = []
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbrex-"))
        const socket = path.join(dir, "s.sock")

        const server = net.createServer((conn) => {
          let upgraded = false
          const read = messageReader()
          conn.on("data", (data) => {
            if (upgraded) {
              for (const message of read(Buffer.from(data))) hellos.push(Buffer.from(message.data).toString())
              conn.write(
                serverFrame(
                  OPCODE.text,
                  Buffer.from(
                    JSON.stringify({ type: "welcome", protocol: "rex.control.v1", api_server_revision: revision }),
                  ),
                ),
              )

              if (closeAfterWelcome) conn.write(serverFrame(OPCODE.close, Buffer.alloc(0)))

              return
            }

            const key = /Sec-WebSocket-Key: (\S+)/.exec(data.toString())?.[1] ?? ""

            const accept = crypto
              .createHash("sha1")
              .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
              .digest("base64")

            upgraded = true
            conn.write(
              `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
            )
          })
        })

        server.listen(socket, () => resume(Effect.succeed({ socket, server, hellos })))
      },
    ),
    ({ socket, server }) =>
      Effect.sync(() => {
        server.close()
        fs.rmSync(path.dirname(socket), { recursive: true, force: true })
      }),
  )

describe("runtime-rex against a Rex server older than API revision 18", () => {
  it.live("reports blocked with a restart hint and refuses to open", () =>
    Effect.gen(function* () {
      const { socket } = yield* fakeServer(11)

      const runtime = yield* make({
        connect: connect((endpoint) => NodeSocket.makeNet({ path: endpoint }), socket),
        socket,
        scope: yield* Effect.scope,
        shell: "/bin/sh",
      })

      const status = yield* runtime.status()
      assert.strictEqual(status.status, "blocked")

      if (status.status === "blocked") assert.match(status.reason, /revision 11.*restart Rex Server/)

      const opened = yield* runtime
        .open({ project: "/tmp", cwd: "/tmp", launch: { argv: [], env: {} }, label: "x" })
        .pipe(Effect.flip)

      assert.strictEqual(opened.code, "incompatible")
    }).pipe(Effect.scoped),
  )
})

describe("a rex.control.v1 connection", () => {
  it.live("asks for API revision 18 in its hello, so Rex pages large replies", () =>
    Effect.gen(function* () {
      const { socket, hellos } = yield* fakeServer(18)
      yield* connect((endpoint) => NodeSocket.makeNet({ path: endpoint }), socket)
      assert.strictEqual(JSON.parse(hellos[0] ?? "{}").api_revision, 18)
    }).pipe(Effect.scoped),
  )

  it.live("fails a call at once with unreachable after the server closed the connection", () =>
    Effect.gen(function* () {
      const { socket } = yield* fakeServer(18, true)
      const connection = yield* connect((endpoint) => NodeSocket.makeNet({ path: endpoint }), socket)
      yield* Effect.sleep("200 millis")

      const failed = yield* connection.call("server.version", {}).pipe(Effect.flip, Effect.timeout("2 seconds"))

      assert.strictEqual(failed.code, "unreachable")
    }).pipe(Effect.scoped),
  )
})
