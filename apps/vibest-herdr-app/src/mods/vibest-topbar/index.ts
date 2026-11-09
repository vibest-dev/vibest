import { type Element, View } from "gpui-kit"
import { layout, panes, run, settings, spaces, window } from "herdr"

import { BAR_HEIGHT, barExtra } from "../../shared/terminal-fit.ts"
import { themeColors } from "../../shared/theme-colors.ts"
import { TRAFFIC_LIGHTS_INSET } from "../../shared/traffic-lights.ts"
import { topbarState } from "./topbar-state.ts"
import { topbarView } from "./view.ts"

export default class Topbar extends View {
  extra: number | null = null

  fit(): void {
    const extra = barExtra(globalThis.window.viewport_size().height, Number(settings().font_size ?? 14))
    if (extra === this.extra) return
    this.extra = extra
    run("layout.resize", { id: "topbar", px: BAR_HEIGHT + extra })
    run("layout.resize", { id: "sidebar-header", px: BAR_HEIGHT + extra })
  }

  render(): Element {
    this.fit()
    const state = topbarState(layout(), spaces(), panes())
    const w = window()
    const lights = w?.platform === "macos" && !w.fullscreen && state.sidebarHidden
    return topbarView(themeColors(), state, { inset: lights ? TRAFFIC_LIGHTS_INSET : 0, buttons: Boolean(w?.buttons) })
  }
}
