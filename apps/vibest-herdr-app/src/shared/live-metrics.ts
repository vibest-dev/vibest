import { layout, settings, window } from "herdr"

import { type Metrics, metrics } from "./metrics.ts"

export const liveMetrics = (): Metrics =>
  metrics(layout(), globalThis.window.viewport_size().height, Number(settings().font_size ?? 14))

export const lightsShown = (): boolean => {
  const w = window()
  return w?.platform === "macos" && !w.fullscreen
}
