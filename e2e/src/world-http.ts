import http from "node:http"
import path from "node:path"

import type { Schema } from "effect"

const unixHttp = (
  socketPath: string,
  method: string,
  urlPath: string,
  headers: Readonly<Record<string, string>>,
  body?: string,
) =>
  new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: urlPath,
        headers: {
          ...(body !== undefined && {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          }),
          ...headers,
        },
      },
      (res) => {
        let out = ""
        res.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8")
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }))
      },
    )

    req.on("error", reject)

    if (body !== undefined) req.write(body)
    req.end()
  })

const firstSseEvent = (socketPath: string, urlPath: string, headers: Readonly<Record<string, string>>) =>
  new Promise<{ readonly status: number; readonly data: unknown }>((resolve, reject) => {
    let settled = false

    const finish = (err?: Error, value?: { readonly status: number; readonly data: unknown }) => {
      if (settled) return
      settled = true
      req.destroy()

      if (err !== undefined) reject(err)
      else resolve(value!)
    }

    const req = http.request({ socketPath, method: "GET", path: urlPath, headers }, (res) => {
      const status = res.statusCode ?? 0
      let buf = ""
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8")

        if (status >= 400) return

        for (const line of buf.split("\n")) {
          if (!line.startsWith("data:")) continue
          const payload = line.slice(5).trim()

          if (payload === "") continue
          finish(undefined, { status, data: JSON.parse(payload) as unknown })

          return
        }
      })
      res.on("end", () => {
        if (settled) return

        if (status >= 400) finish(new Error(`${urlPath} (${status}): ${buf}`))
        else finish(new Error(`${urlPath} ended before first SSE event`))
      })
    })

    req.on("error", (e) => finish(e))
    req.end()
  })

const vibestdProtocol = async (socketPath: string) => {
  const ping = await unixHttp(socketPath, "GET", "/api/daemon/ping", {})
  const parsed = JSON.parse(ping.body) as { protocol?: number }

  return String(parsed.protocol)
}

export const vibestd = async (
  w: { readonly vibestHome: string },
  repo: string,
  method: string,
  urlPath: string,
  body?: Schema.Json,
) => {
  const socketPath = path.join(w.vibestHome, "vibest.sock")
  const protocol = await vibestdProtocol(socketPath)

  const headers = {
    "vibest-protocol": protocol,
    "vibest-caller": "cli",
    "vibest-repository": repo,
  }

  const reply = await unixHttp(
    socketPath,
    method,
    urlPath,
    headers,
    body === undefined ? undefined : JSON.stringify(body),
  )

  const parsed = reply.body.trim() === "" ? undefined : (JSON.parse(reply.body) as unknown)

  return reply.status >= 400 ? { error: parsed } : { result: parsed }
}

export const vibestdWatch = async (w: { readonly vibestHome: string }, repo: string) => {
  const socketPath = path.join(w.vibestHome, "vibest.sock")
  const protocol = await vibestdProtocol(socketPath)

  const reply = await firstSseEvent(socketPath, "/api/watch", {
    "vibest-protocol": protocol,
    "vibest-caller": "cli",
    "vibest-repository": repo,
  })

  return reply.data
}
