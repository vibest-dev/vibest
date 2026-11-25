import { layout, run, window } from "herdr"

import type { LayoutNode } from "./layout-tree.ts"
import { fitLayout, type Metrics, metrics } from "./metrics.ts"

export const liveLayout = (): LayoutNode | undefined => {
  const raw = layout()

  if (!raw) return undefined

  return JSON.parse(JSON.stringify(raw))
}

export const liveMetrics = (): Metrics => metrics(liveLayout())

export const lightsShown = (): boolean => {
  const w = window()

  return w?.platform === "macos" && !w.fullscreen
}

export const applyLayout = (): void => {
  const next = fitLayout(liveLayout(), liveMetrics())

  if (next) run("layout.set", { layout: next })
}
