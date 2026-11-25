import { type Element, View } from "gpui-kit"
import { checking, panes, spaces, window } from "herdr"

import { findNode } from "../../shared/layout-tree.ts"
import { applyLayout, lightsShown, liveLayout, liveMetrics } from "../../shared/live-metrics.ts"
import { CONTENT, LEFT_GUTTER, LIGHTS_INSET } from "../../shared/metrics.ts"
import { themeColors } from "../../shared/theme-colors.ts"
import { topbarState } from "./topbar-state.ts"
import { topbarView } from "./view.ts"

export default class Topbar extends View {
  render(): Element {
    const tree = liveLayout()
    const m = liveMetrics()

    if (!checking()) applyLayout()

    const state = topbarState(tree, spaces(), panes())
    const gutter = findNode(tree, LEFT_GUTTER)
    const gutterWidth = gutter && !gutter.hidden ? CONTENT : 0

    return topbarView(themeColors(), state, {
      inset: lightsShown() && state.sidebarHidden ? LIGHTS_INSET - gutterWidth : 0,
      buttons: Boolean(window()?.buttons),
      pad: m.pad,
    })
  }
}
