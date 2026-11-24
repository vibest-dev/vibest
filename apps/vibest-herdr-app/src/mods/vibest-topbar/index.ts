import { type Element, View } from "gpui-kit"
import { checking, panes, run, spaces, window } from "herdr"

import { lightsShown, liveLayout, liveMetrics } from "../../shared/live-metrics.ts"
import { fitLayout, LIGHTS_INSET } from "../../shared/metrics.ts"
import { themeColors } from "../../shared/theme-colors.ts"
import { topbarState } from "./topbar-state.ts"
import { topbarView } from "./view.ts"

export default class Topbar extends View {
  render(): Element {
    const tree = liveLayout()
    const m = liveMetrics()
    const next = fitLayout(tree, m)

    if (!checking() && next) run("layout.set", { layout: next })

    const state = topbarState(tree, spaces(), panes())

    return topbarView(themeColors(), state, {
      inset: lightsShown() && state.sidebarHidden ? LIGHTS_INSET : 0,
      buttons: Boolean(window()?.buttons),
      pad: m.pad,
    })
  }
}
