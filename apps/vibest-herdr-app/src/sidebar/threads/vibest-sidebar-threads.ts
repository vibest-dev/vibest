import { type AsyncContext, type Element, View } from "gpui-kit"

import { themeColors } from "../../shared/theme.ts"
import { ThreadList } from "./view.ts"

export default class SidebarThreads extends View {
  list!: ThreadList

  init(_props: unknown, cx: AsyncContext): void {
    this.list = new ThreadList(cx)
  }

  render(): Element {
    return this.list.render(themeColors())
  }
}
