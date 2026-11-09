import { type Context, div, type Element, svg } from "gpui-kit"

import type { Theme } from "./theme.ts"

export const TRAFFIC_LIGHTS_INSET = 90

export const icon = (name: string): string => `mods/workspace-chrome/${name}.svg`

export const iconButton = (
  t: Theme,
  id: string,
  name: string,
  action: (cx: Context) => void,
  { size = 28, on = false }: { readonly size?: number; readonly on?: boolean } = {},
): Element =>
  div()
    .id(id)
    .size(size)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .rounded(8)
    .when(on, (el) => el.bg(t.selected))
    .text_color(on ? t.foreground : t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .cursor_pointer()
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => {
      cx.stop_propagation()
      action(cx)
    })
    .child(svg(icon(name)).size(16))
