import { type AsyncContext, type Element, View } from "gpui-kit"
import { checking } from "herdr"

import { projectGroups } from "../../shared/project-groups.ts"
import { selectedProject } from "../../shared/session-ui.ts"
import { themeColors } from "../../shared/theme-colors.ts"
import { VibestFeed } from "../../shared/vibest-source.ts"
import { agentsView, shownGroup } from "./view.ts"

const CLOCK_MS = 30_000

export default class Agents extends View {
  now: number
  feed: VibestFeed

  init(_props: Record<string, never>, cx: AsyncContext): void {
    this.now = Date.now()
    this.feed = new VibestFeed()

    if (checking()) return

    this.feed.start(cx)

    cx.timer.every(CLOCK_MS, (ticked) => {
      this.now = Date.now()
      ticked.notify()
    })
  }

  render(): Element {
    const state = this.feed.state

    return agentsView(themeColors(), shownGroup(projectGroups(state), selectedProject()), state, this.now)
  }
}
