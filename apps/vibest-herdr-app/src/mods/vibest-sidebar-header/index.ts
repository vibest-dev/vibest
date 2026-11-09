import { h_flex } from "gpui-base"
import { div, type Element, View } from "gpui-kit"
import { window } from "herdr"

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
    .gap(4)
    .bg(t.chrome)
    .text_size(14)
    .child(div().font_medium().text_color(t.foreground).child("Vibest"))
}

export default class SidebarHeader extends View {
  render(): Element {
    return header(themeColors())
  }
}
