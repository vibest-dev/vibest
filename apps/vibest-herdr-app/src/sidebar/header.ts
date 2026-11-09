import { h_flex } from "gpui-base"
import { div, View } from "gpui-kit"
import { type Theme, theme, window } from "herdr"

import { TRAFFIC_LIGHTS_INSET } from "../shared/ui.ts"

const header = (t: Theme): Chain => {
  const w = window()
  const inset = w?.platform === "macos" && !w.fullscreen ? TRAFFIC_LIGHTS_INSET : 16
  return h_flex()
    .size_full()
    .pl(inset)
    .pr(12)
    .items_center()
    .gap(4)
    .bg(t.chrome)
    .text_size(14)
    .child(div().font_medium().text_color(t.foreground).child("Vibest"))
}

export default class SidebarHeader extends View {
  render(): unknown {
    return header(theme())
  }
}
