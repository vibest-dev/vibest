import { h_flex } from "gpui-base"
import { type Element, View } from "gpui-kit"
import { run } from "herdr"

import { iconButton } from "../../shared/icon-button.ts"
import { lightsShown, liveMetrics } from "../../shared/live-metrics.ts"
import { INSET, LIGHTS_INSET } from "../../shared/metrics.ts"
import { type Theme, themeColors } from "../../shared/theme-colors.ts"

const header = (t: Theme): Element => {
  return h_flex()
    .size_full()
    .pl(lightsShown() ? LIGHTS_INSET : INSET)
    .pr(12)
    .pt(liveMetrics().pad)
    .items_center()
    .bg(t.chrome)
    .child(
      iconButton(t, "toggle-sidebar", "mods/vibest-sidebar-header/panel-left-close.svg", () =>
        run("layout.toggle", { id: "sidebar" }),
      ),
    )
}

export default class SidebarHeader extends View {
  render(): Element {
    return header(themeColors())
  }
}
