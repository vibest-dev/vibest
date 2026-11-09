import { View } from "gpui-kit"
import { theme } from "herdr"

import { AgentList } from "./view.ts"

export default class Agents extends View {
  list!: AgentList

  init(_props: unknown, cx: Cx): void {
    this.list = new AgentList(cx)
  }

  close(): void {
    this.list.close()
  }

  render(): unknown {
    return this.list.render(theme())
  }
}
