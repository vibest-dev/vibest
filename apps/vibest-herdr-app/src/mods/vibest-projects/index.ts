import { type AsyncContext, type Context, type Element, View } from "gpui-kit"
import { checking, nextCommand } from "herdr"

import { projectGroups } from "../../shared/project-groups.ts"
import { followProject, openProject, previousProject, restoreChat, selectedProject } from "../../shared/session-ui.ts"
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
    restoreChat()

    cx.spawn(async (task) => {
      for (;;) if ((await nextCommand()) === "recent") this.openRecent(task)
    })

    cx.timer.every(CLOCK_MS, (ticked) => {
      this.now = Date.now()
      ticked.notify()
    })
  }

  openRecent(cx: Context): void {
    const g = projectGroups(this.feed.state).find((group) => group.key === previousProject())
    const first = g?.members[0]

    if (g && first) openProject(g.key, first, cx)
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
    const groups = projectGroups(state)

    this.selected = selectedProject()

    if (!checking()) followProject(groups)

    return new ProjectsView(themeColors(), this).render(groups, state.note)
  }
}
