import { type AsyncContext, type Context, type Element, View } from "gpui-kit"
import { checking, panes, spaces } from "herdr"

import { themeColors } from "../../shared/theme-colors.ts"
import { parseExpanded, projects } from "./projects.ts"
import { type ThreadsUi, ThreadsView } from "./view.ts"

const CLOCK_MS = 30000

export default class SidebarThreads extends View implements ThreadsUi {
  hovered: string | null
  expanded: Set<string>
  now: number

  init(_props: Record<string, never>, cx: AsyncContext): void {
    this.hovered = null
    this.expanded = new Set(parseExpanded(localStorage.getItem("expanded")))
    this.now = Date.now()

    if (checking()) return

    cx.timer.every(CLOCK_MS, (ticked) => {
      this.now = Date.now()
      ticked.notify()
    })
  }

  hover(id: string) {
    return (on: boolean, cx: Context): void => {
      if (on) this.hovered = id
      else if (this.hovered === id) this.hovered = null

      cx.notify()
    }
  }

  toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id)
    else this.expanded.add(id)

    localStorage.setItem("expanded", JSON.stringify([...this.expanded]))
  }

  render(): Element {
    return new ThreadsView(themeColors(), this).render(projects(spaces(), panes()))
  }
}
