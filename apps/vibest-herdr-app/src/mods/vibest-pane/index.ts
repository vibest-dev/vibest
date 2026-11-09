import { div, type Element, View } from "gpui-kit"
import { home, panes, props } from "herdr"

import { themeColors } from "../../shared/theme-colors.ts"
import { paneHeader } from "./view.ts"

export default class PaneHeader extends View {
  render(): Element {
    const p = panes().find((pane) => pane.pane === props()?.pane)
    return p ? paneHeader(themeColors(), p, home()) : div()
  }
}
