import { Buffer } from "buffer"

import { describe, expect, it } from "vitest"

import { SseResponse } from "./sse.ts"

const bytes = (s: string): Uint8Array => Buffer.from(s, "utf8")

describe("SseResponse", () => {
  it("reads events split anywhere, including inside a multi-byte character", () => {
    const whole = bytes(
      'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n: keep-alive\n\ndata: {"_tag":"Project","name":"é"}\n\ndata: {"_tag":"MachineRemoved","name":"m"}\n\n',
    )

    const sse = new SseResponse()
    const frames = [...whole].flatMap((b) => sse.push(Uint8Array.of(b)))

    expect(sse.status).toBe(200)
    expect(frames).toEqual(
      JSON.parse('[{"result":[{"_tag":"Project","name":"é"}]},{"result":[{"_tag":"MachineRemoved","name":"m"}]}]'),
    )
  })

  it("turns a named failure event into an error frame", () => {
    const sse = new SseResponse()

    const frames = sse.push(bytes('HTTP/1.1 200 OK\r\n\r\nevent: failure\ndata: {"_tag":"WatchLagged"}\n\n'))

    expect(frames.map((f) => f.error?._tag)).toEqual(["WatchLagged"])
  })

  it("keeps a refused request's message", () => {
    const sse = new SseResponse()

    expect(sse.push(bytes('HTTP/1.1 401 Unauthorized\r\n\r\n{"message":"invalid vibest-token"}'))).toEqual([])
    expect(sse.status).toBe(401)
    expect(sse.refusal()).toBe("invalid vibest-token")
  })
})
