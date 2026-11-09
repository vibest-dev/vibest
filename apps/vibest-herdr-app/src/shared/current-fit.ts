import { layout, settings } from "herdr"

import { type Fit, fit } from "./terminal-fit.ts"

export const currentFit = (): Fit =>
  fit(layout(), globalThis.window.viewport_size().height, Number(settings().font_size ?? 14))
