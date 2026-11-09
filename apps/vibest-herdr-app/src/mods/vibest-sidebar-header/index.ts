import { h_flex } from "gpui-base"
import { type Element, View } from "gpui-kit"
import { run, window } from "herdr"

import { iconButton } from "../../shared/icon-button.ts"
import { type Theme, themeColors } from "../../shared/theme-colors.ts"
import { TRAFFIC_LIGHTS_INSET } from "../../shared/traffic-lights.ts"

const header = (t: Theme): Element => {
  const w = window()
  const inset = w?.platform === "macos" && !w.fullscreen ? TRAFFIC_LIGHTS_INSET : 16
  return h_flex()
    .size_full()
    .pl(inset)
    .pr(12)
    .pt(8)
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
