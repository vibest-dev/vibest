import { type AsyncContext, type Context, type Element, View } from "gpui-kit"
import { panes, spaces } from "herdr"

import { themeColors } from "../../shared/theme-colors.ts"
import { parseFolded, projects } from "./projects.ts"
import { type ThreadsUi, ThreadsView } from "./view.ts"

const CLOCK_MS = 30000

export default class SidebarThreads extends View implements ThreadsUi {
  hovered: string | null
  folded: Set<string>
  now: number

  init(_props: unknown, cx: AsyncContext): void {
    this.hovered = null
    this.folded = new Set(parseFolded(localStorage.getItem("folded")))
    this.now = Date.now()
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

  fold(id: string): void {
    if (this.folded.has(id)) this.folded.delete(id)
    else this.folded.add(id)
    localStorage.setItem("folded", JSON.stringify([...this.folded]))
  }

  render(): Element {
    return new ThreadsView(themeColors(), this).render(projects(spaces(), panes()))
  }
}
