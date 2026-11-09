import type { Color } from "gpui-kit"
import { theme } from "herdr"

export type Theme = Readonly<Record<string, Color>>

export const themeColors = (): Theme => theme() as Theme
