import { type AsyncContext, type Context, type Element, View } from "gpui-kit"
import { checking, nextCommand } from "herdr"

import { projectGroups } from "../../shared/project-groups.ts"
import { openProject, previousProject, selectedProject } from "../../shared/session-ui.ts"
import { themeColors } from "../../shared/theme-colors.ts"
import { VibestFeed } from "../../shared/vibest-source.ts"
import { type ProjectsUi, ProjectsView } from "./view.ts"

const CLOCK_MS = 30_000

export default class Projects extends View implements ProjectsUi {
  hovered: string | null
  selected: string | null
  now: number
  feed: VibestFeed

  init(_props: Record<string, never>, cx: AsyncContext): void {
    this.hovered = null
    this.now = Date.now()
    this.feed = new VibestFeed()

    if (checking()) return

    this.feed.start(cx)

    cx.spawn(async () => {
      for (;;) if ((await nextCommand()) === "recent") this.openRecent()
    })

    cx.timer.every(CLOCK_MS, (ticked) => {
      this.now = Date.now()
      ticked.notify()
    })
  }

  openRecent(): void {
    const g = projectGroups(this.feed.state).find((group) => group.key === previousProject())
    const first = g?.members[0]

    if (g && first) openProject(g.key, first)
  }

  hover(id: string) {
    return (on: boolean, cx: Context): void => {
      if (on) this.hovered = id
      else if (this.hovered === id) this.hovered = null

      cx.notify()
    }
  }

  render(): Element {
    const state = this.feed.state

    this.selected = selectedProject()

    return new ProjectsView(themeColors(), this).render(projectGroups(state), state.note)
  }
}
