import { View } from "gpui-kit"
import { theme } from "herdr"

import { ThreadList } from "./view.ts"

export default class SidebarThreads extends View {
  list!: ThreadList

  init(_props: unknown, cx: Cx): void {
    this.list = new ThreadList(cx)
  }

  render(): unknown {
    return this.list.render(theme())
  }
}
