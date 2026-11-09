import { type AsyncContext, type Element, View } from "gpui-kit"

import { themeColors } from "../../shared/theme.ts"
import { AgentList } from "./view.ts"

export default class Agents extends View {
  list!: AgentList

  init(_props: unknown, cx: AsyncContext): void {
    this.list = new AgentList(cx)
  }

  close(): void {
    this.list.close()
  }

  render(): Element {
    return this.list.render(themeColors())
  }
}
