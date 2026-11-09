import { div, type Element, View } from "gpui-kit"
import { home, panes, props } from "herdr"

import { themeColors } from "../../shared/theme-colors.ts"
import { paneHeader } from "./view.ts"

export default class PaneHeader extends View {
  hovered: boolean

  init(): void {
    this.hovered = false
  }

  render(): Element {
    const p = panes().find((pane) => pane.pane === props()?.pane)
    if (!p) return div()
    return paneHeader(themeColors(), p, home(), this.hovered, (on, cx) => {
      this.hovered = on
      cx.notify()
    })
  }
}
