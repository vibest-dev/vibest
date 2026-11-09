import { View } from "gpui-kit"
import { props, type Theme, theme } from "herdr"

import { AgentList } from "./agents/view.ts"
import { footer } from "./footer.ts"
import { header } from "./header.ts"
import { ThreadList } from "./threads/view.ts"
import { topbar } from "./topbar.ts"

const PARTS: Partial<Record<string, (t: Theme) => Chain>> = { header, footer, topbar }

export default class Vibest extends View {
  list: ThreadList | AgentList | undefined

  init(_props: unknown, cx: Cx): void {
    const part = props()?.part ?? ""
    if (part === "agents") this.list = new AgentList(cx)
    else if (PARTS[part] === undefined) this.list = new ThreadList(cx)
  }

  close(): void {
    if (this.list instanceof AgentList) this.list.close()
  }

  render(): unknown {
    const t = theme()
    return this.list ? this.list.render(t) : PARTS[props()?.part ?? ""]?.(t)
  }
}
