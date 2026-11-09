import { type AsyncContext, type Context, type Element, View } from "gpui-kit"
import { appHome, exec } from "herdr"

import { themeColors } from "../../shared/theme-colors.ts"
import { LS_ARGV, type LsResult, lsFailure, readLsResult } from "./ls.ts"
import { closePull, completePull, idlePull, type Pull, requestPull } from "./pull.ts"
import { agentsView } from "./view.ts"

export default class Agents extends View {
  shown: LsResult
  pull: Pull

  init(_props: unknown, cx: AsyncContext): void {
    this.shown = { sessions: [], note: "Reading vibestd…", asOf: "" }
    this.pull = idlePull()
    this.request(cx)
  }

  close(): void {
    this.pull = closePull(this.pull)
  }

  request(cx: Context): void {
    const next = requestPull(this.pull)
    const started = !this.pull.running && next.running
    this.pull = next
    if (started) this.spawnRead(cx, next.token)
  }

  spawnRead(cx: Context, token: number): void {
    cx.spawn(async (spawned) => {
      const result = await exec("env", [...LS_ARGV], { cwd: appHome() }).then(
        (listed) => readLsResult(listed, new Date()),
        lsFailure,
      )
      const done = completePull(this.pull, token)
      this.pull = done.pull
      if (done.apply) {
        this.shown = result
        spawned.notify()
      }
      if (this.pull.running) this.spawnRead(spawned, this.pull.token)
    })
  }

  render(): Element {
    return agentsView(themeColors(), this.shown, (cx) => this.request(cx))
  }
}
