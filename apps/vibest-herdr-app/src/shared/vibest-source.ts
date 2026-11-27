import net from "net"

import type { AsyncContext } from "gpui-kit"
import { appHome, home, readTextFile } from "herdr"

import { SseResponse } from "./sse.ts"
import type { VibestState } from "./vibest-model.ts"
import { applyFrame, emptyState } from "./watch-state.ts"

const RETRY_MS = 3000

interface Daemon {
  readonly url: string
  readonly port: number
  readonly token: string
  readonly protocol: number
}

interface FeedConfig {
  readonly home?: string
}

const vibestHome = async (): Promise<string> => {
  const text = await readTextFile(`${appHome()}/vibest.json`)
  const config: FeedConfig = text === null ? {} : JSON.parse(text)

  return config.home ?? `${home()}/.vibest`
}

const daemon = async (): Promise<Daemon | null> => {
  const text = await readTextFile(`${await vibestHome()}/vibestd.pid`)

  return text === null || text.trim() === "" ? null : (JSON.parse(text).http ?? null)
}

const auth = (d: Daemon) => ({
  "vibest-token": d.token,
  "vibest-protocol": String(d.protocol),
})

interface LaunchParams {
  readonly projectId: string
  readonly sessionId: string | undefined
  readonly harness: string
  readonly runtime: string
  readonly focus: boolean
}

const call = async <T>(method: string, path: string, body?: LaunchParams): Promise<T | null> => {
  const d = await daemon()

  if (!d) throw new Error("vibestd is not running")

  const init: ShellFetchOptions = { method, headers: auth(d) }

  if (body) {
    init.headers = { ...auth(d), "content-type": "application/json" }
    init.body = JSON.stringify(body)
  }

  const response = await fetch(`${d.url}${path}`, init)
  const text = await response.text()
  const reply: (T & { message?: string }) | null = text === "" ? null : JSON.parse(text)

  if (!response.ok) throw new Error(reply?.message ?? `vibestd answered ${response.status}`)

  return reply
}

export const launch = async (params: LaunchParams): Promise<void> => {
  await call<object>("POST", "/api/session/launch", params)
}

export interface HarnessChoice {
  readonly harness: string
  readonly problem: string | null
}

export const harnesses = async (): Promise<HarnessChoice[]> =>
  (await call<HarnessChoice[]>("GET", "/api/harness")) ?? []

export class VibestFeed {
  state: VibestState = emptyState("Connecting…")

  start(cx: AsyncContext): void {
    cx.spawn(async (task) => {
      await this.watch(task).catch((error: Error) => this.set(task, emptyState(`vibestd: ${error.message}`)))
      task.timer.after(RETRY_MS, (again) => this.start(again))
    })
  }

  set(cx: AsyncContext, state: VibestState): void {
    this.state = state
    cx.notify()
  }

  async watch(cx: AsyncContext): Promise<void> {
    const d = await daemon()

    if (!d) return this.set(cx, emptyState("vibestd is not running"))

    const socket = await net.connect("127.0.0.1", d.port)
    const sse = new SseResponse()
    const headers = Object.entries(auth(d)).map(([k, v]) => `${k}: ${v}\r\n`)

    await socket.write(`GET /api/watch HTTP/1.0\r\naccept: text/event-stream\r\n${headers.join("")}\r\n`)

    try {
      for (;;) {
        const bytes = await socket.read()

        if (bytes === null) {
          if (sse.status !== 200) throw new Error(sse.refusal())

          return this.set(cx, { ...this.state, note: "vibestd ended the watch, reconnecting…" })
        }

        const frames = sse.push(bytes)

        if (frames.length > 0) this.set(cx, frames.reduce(applyFrame, this.state))

        if (frames.some((frame) => frame.error)) return
      }
    } finally {
      socket.close()
    }
  }
}
