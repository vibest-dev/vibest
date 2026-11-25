import type { AsyncContext } from "gpui-kit"
import { appHome, home, readTextFile } from "herdr"
import { WebSocket, type WebSocketSocket } from "websocket"

import type { VibestState } from "./vibest-model.ts"
import { applyFrame, emptyState, type WatchFrame } from "./watch-state.ts"

const RETRY_MS = 3000

interface DaemonInfo {
  readonly ws?: { readonly url: string; readonly token: string; readonly protocol: number }
}

interface FeedConfig {
  readonly home?: string
}

const vibestHome = async (): Promise<string> => {
  const text = await readTextFile(`${appHome()}/vibest.json`)
  const config: FeedConfig = text === null ? {} : JSON.parse(text)

  return config.home ?? `${home()}/.vibest`
}

const frames = (text: string): WatchFrame[] =>
  text.split("\n").flatMap((line) => (line.trim() === "" ? [] : [JSON.parse(line)]))

const connect = async (): Promise<WebSocketSocket | null> => {
  const text = await readTextFile(`${await vibestHome()}/vibestd.pid`)
  const info: DaemonInfo = text === null ? {} : JSON.parse(text)

  if (!info.ws) return null

  return WebSocket.connect(info.ws.url, {
    headers: { "vibest-token": info.ws.token, "vibest-protocol": String(info.ws.protocol) },
  })
}

interface LaunchParams {
  readonly projectId: string
  readonly sessionId: string | undefined
  readonly harness: string
  readonly runtime: string
  readonly focus: boolean
}

export const launch = async (params: LaunchParams): Promise<void> => {
  const socket = await connect()

  if (!socket) throw new Error("vibestd is not running")

  await socket.write(JSON.stringify({ jsonrpc: "2.0", id: "launch", method: "Launch", params }))

  const reply = await socket.read()

  socket.close()

  const error = reply instanceof Uint8Array ? undefined : JSON.parse(reply).error

  if (error) throw new Error(error.message ?? "vibestd could not start it")
}

export interface HarnessChoice {
  readonly harness: string
  readonly problem: string | null
}

export const harnesses = async (): Promise<HarnessChoice[]> => {
  const socket = await connect()

  if (!socket) return []

  await socket.write(JSON.stringify({ jsonrpc: "2.0", id: "harnesses", method: "Harnesses.List", params: {} }))

  const reply = await socket.read()

  socket.close()

  return reply instanceof Uint8Array ? [] : (JSON.parse(reply).result ?? [])
}

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
    const socket = await connect()

    if (!socket) return this.set(cx, emptyState("vibestd is not running or has no WebSocket"))

    await socket.write(JSON.stringify({ jsonrpc: "2.0", id: "watch", method: "Watch", params: {} }))

    for (;;) {
      const message = await socket.read()

      if (message instanceof Uint8Array) continue

      const batch = frames(message)

      this.set(cx, batch.reduce(applyFrame, this.state))

      if (batch.some((frame) => frame.error)) return socket.close()
    }
  }
}
