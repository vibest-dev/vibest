import { type AsyncContext, type Context, type Element, View } from "gpui-kit"
import { checking, focused, nextCommand, run } from "herdr"

import { projectGroups } from "../../shared/project-groups.ts"
import { isProjectTab } from "../../shared/project-space.ts"
import { followProjects, openProject, previousProject, selectedProject } from "../../shared/session-ui.ts"
import { themeColors } from "../../shared/theme-colors.ts"
import { VibestFeed } from "../../shared/vibest-source.ts"
import { type ProjectsUi, ProjectsView } from "./view.ts"

const CLOCK_MS = 30_000

const CLOSE = new Map([
  ["close-tab", "tab.close"],
  ["close-pane", "pane.close"],
])

export default class Projects extends View implements ProjectsUi {
  hovered: string | null
  selected: string | null
  now: number
  feed: VibestFeed
  cx: AsyncContext

  init(_props: Record<string, never>, cx: AsyncContext): void {
    this.hovered = null
    this.now = Date.now()
    this.feed = new VibestFeed()
    this.cx = cx

    if (checking()) return

    this.feed.start(cx)

    cx.spawn(async (task) => {
      for (;;) this.command(await nextCommand(), task)
    })

    cx.timer.every(CLOCK_MS, (ticked) => {
      this.now = Date.now()
      ticked.notify()
    })
  }

  command(name: string, cx: Context): void {
    if (name === "recent") return this.openRecent(cx)

    const close = CLOSE.get(name)

    if (close && !isProjectTab(focused()?.tab)) run(close)
  }

  openRecent(cx: Context): void {
    const g = projectGroups(this.feed.state).find((group) => group.key === previousProject())
    const first = g?.members[0]

    if (g && first) openProject(g.key, g.label, first, cx)
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

    this.selected = selectedProject(groups)

    if (!checking()) followProjects(groups, this.cx)

    return new ProjectsView(themeColors(), this).render(groups, state.note)
  }
}
