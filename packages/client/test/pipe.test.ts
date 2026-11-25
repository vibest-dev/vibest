import stream from "node:stream"

import { assert, describe, it } from "@effect/vitest"
import { connectPipe, stdioSocket } from "@vibest/client/pipe"
import { Effect, Predicate } from "effect"

describe("multiplexed HTTP pipe handshake", () => {
  it.effect("fails fast with PipeIncompatible when a legacy peer sends non-HTTP bytes", () =>
    Effect.gen(function* () {
      const c2s = new stream.PassThrough()
      c2s.resume()
      const s2c = new stream.PassThrough()
      s2c.write('{"jsonrpc":"2.0","id":"1","result":{}}\n')

      const sock = yield* stdioSocket({
        writable: stream.Writable.toWeb(c2s) as WritableStream<Uint8Array>,
        readable: stream.Readable.toWeb(s2c) as ReadableStream<Uint8Array>,
      })

      const failed = yield* Effect.flip(connectPipe(sock))
      assert.isTrue(Predicate.isTagged(failed, "PipeIncompatible"))
    }).pipe(Effect.scoped),
  )

  it.effect("fails fast with PipeIncompatible when a peer closes stdout before handshake", () =>
    Effect.gen(function* () {
      const c2s = new stream.PassThrough()
      c2s.resume()
      const s2c = new stream.PassThrough()
      s2c.end()

      const sock = yield* stdioSocket({
        writable: stream.Writable.toWeb(c2s) as WritableStream<Uint8Array>,
        readable: stream.Readable.toWeb(s2c) as ReadableStream<Uint8Array>,
      })

      const failed = yield* Effect.flip(connectPipe(sock))
      assert.isTrue(Predicate.isTagged(failed, "PipeIncompatible"))
    }).pipe(Effect.scoped),
  )
})
