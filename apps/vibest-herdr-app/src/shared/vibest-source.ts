import type { AsyncContext } from "gpui-kit"
import { appHome, home, readTextFile } from "herdr"
import { WebSocket } from "websocket"

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
    const text = await readTextFile(`${await vibestHome()}/vibestd.pid`)
    const info: DaemonInfo = text === null ? {} : JSON.parse(text)

    if (!info.ws) return this.set(cx, emptyState("vibestd is not running or has no WebSocket"))

    const socket = await WebSocket.connect(info.ws.url, {
      headers: { "vibest-token": info.ws.token, "vibest-protocol": String(info.ws.protocol) },
    })

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
