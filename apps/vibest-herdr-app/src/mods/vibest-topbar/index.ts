import { type Element, View } from "gpui-kit"
import { layout, panes, run, spaces, window } from "herdr"

import { currentFit } from "../../shared/current-fit.ts"
import { fitLayout } from "../../shared/terminal-fit.ts"
import { themeColors } from "../../shared/theme-colors.ts"
import { TRAFFIC_LIGHTS_INSET } from "../../shared/traffic-lights.ts"
import { topbarState } from "./topbar-state.ts"
import { topbarView } from "./view.ts"

export default class Topbar extends View {
  render(): Element {
    const f = currentFit()
    const next = fitLayout(layout(), f)
    if (next) run("layout.set", { layout: next })
    const state = topbarState(layout(), spaces(), panes())
    const w = window()
    const lights = w?.platform === "macos" && !w.fullscreen && state.sidebarHidden
    return topbarView(themeColors(), state, {
      inset: lights ? TRAFFIC_LIGHTS_INSET : 0,
      buttons: Boolean(w?.buttons),
      pad: f.pad,
    })
  }
}
