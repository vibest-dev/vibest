import { layout, settings, window } from "herdr"

import type { LayoutNode } from "./layout-tree.ts"
import { type Metrics, metrics } from "./metrics.ts"

export const liveLayout = (): LayoutNode | undefined => {
  const raw = layout()

  if (!raw) return undefined

  return JSON.parse(JSON.stringify(raw))
}

export const liveMetrics = (): Metrics =>
  metrics(liveLayout(), globalThis.window.viewport_size().height, Number(settings().font_size ?? 14))

export const lightsShown = (): boolean => {
  const w = window()

  return w?.platform === "macos" && !w.fullscreen
}
