import { View } from "gpui-kit"
import { props, type Theme, theme } from "herdr"

import { footer } from "./footer.ts"
import { header } from "./header.ts"
import { ThreadList } from "./threads.ts"
import { topbar } from "./topbar.ts"

const PARTS: Partial<Record<string, (t: Theme) => Chain>> = { header, footer, topbar }

export default class T3 extends View {
  threads: ThreadList | undefined

  init(_props: unknown, cx: Cx): void {
    if (PARTS[props()?.part ?? ""] === undefined) this.threads = new ThreadList(cx)
  }

  render(): unknown {
    const t = theme()
    return this.threads ? this.threads.render(t) : PARTS[props()?.part ?? ""]?.(t)
  }
}
