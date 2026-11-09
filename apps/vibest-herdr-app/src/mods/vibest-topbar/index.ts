import { type Element, View } from "gpui-kit"
import { layout, panes, spaces, window } from "herdr"

import { themeColors } from "../../shared/theme-colors.ts"
import { TRAFFIC_LIGHTS_INSET } from "../../shared/traffic-lights.ts"
import { topbarState } from "./topbar-state.ts"
import { topbarView } from "./view.ts"

export default class Topbar extends View {
  render(): Element {
    const state = topbarState(layout(), spaces(), panes())
    const w = window()
    const lights = w?.platform === "macos" && !w.fullscreen && state.sidebarHidden
    return topbarView(themeColors(), state, { inset: lights ? TRAFFIC_LIGHTS_INSET : 8, buttons: Boolean(w?.buttons) })
  }
}
