import { type Element, View } from "gpui-kit"
import { layout, panes, run, settings, spaces, window } from "herdr"

import { barExtra, barShift, fitLayout } from "../../shared/terminal-fit.ts"
import { themeColors } from "../../shared/theme-colors.ts"
import { TRAFFIC_LIGHTS_INSET } from "../../shared/traffic-lights.ts"
import { topbarState } from "./topbar-state.ts"
import { topbarView } from "./view.ts"

export default class Topbar extends View {
  fit(): number {
    const extra = barExtra(globalThis.window.viewport_size().height, Number(settings().font_size ?? 14))
    const next = fitLayout(layout(), extra)
    if (next) run("layout.set", { layout: next })
    return extra
  }

  render(): Element {
    const extra = this.fit()
    const state = topbarState(layout(), spaces(), panes())
    const w = window()
    const lights = w?.platform === "macos" && !w.fullscreen && state.sidebarHidden
    return topbarView(themeColors(), state, {
      inset: lights ? TRAFFIC_LIGHTS_INSET : 0,
      buttons: Boolean(w?.buttons),
      shift: barShift(extra),
    })
  }
}
