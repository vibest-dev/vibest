import type { Color } from "gpui-kit"
import { theme } from "herdr"

export interface Theme {
  readonly [key: string]: Color
}

const isColor = (value: string): value is Color => value.startsWith("#")

export const themeColors = (): Theme => {
  const colors: { [key: string]: Color } = {}

  for (const [key, value] of Object.entries(theme())) {
    if (isColor(value)) colors[key] = value
  }

  return colors
}
