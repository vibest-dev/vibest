import { h_flex } from "gpui-base"
import { type Element, View } from "gpui-kit"
import { run, settings, window } from "herdr"

import { iconButton } from "../../shared/icon-button.ts"
import { barExtra, barShift } from "../../shared/terminal-fit.ts"
import { type Theme, themeColors } from "../../shared/theme-colors.ts"
import { TRAFFIC_LIGHTS_INSET } from "../../shared/traffic-lights.ts"

const header = (t: Theme): Element => {
  const w = window()
  const shift = barShift(barExtra(globalThis.window.viewport_size().height, Number(settings().font_size ?? 14)))
  const inset = w?.platform === "macos" && !w.fullscreen ? TRAFFIC_LIGHTS_INSET : 8
  return h_flex()
    .w_full()
    .h(32 + shift)
    .pl(inset)
    .pr(12)
    .pt(8 + shift)
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
