import { h_flex } from "gpui-base"
import { type Color, div, type Element, image, svg } from "gpui-kit"
import { type PaneInfo, run } from "herdr"

import { INSET, SMALL, TEXT } from "../../shared/metrics.ts"
import type { Theme } from "../../shared/theme-colors.ts"
import { paneName, shortFolder } from "./header.ts"

const programIcon = (p: PaneInfo, color: Color): Element | null => {
  if (!p.program?.icon) return null
  return p.program.tint
    ? svg(p.program.icon).size(14).flex_none().text_color(color)
    : image(p.program.icon).w(14).h(14).flex_none()
}

const button = (t: Theme, id: string, name: string, command: string, args: Record<string, unknown>): Element =>
  div()
    .id(id)
    .p(3)
    .rounded(4)
    .text_color(t.dim)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => {
      cx.stop_propagation()
      run(command, args)
    })
    .child(svg(`mods/pane/${name}.svg`).size(14))

export const paneHeader = (t: Theme, p: PaneInfo, home: string): Element => {
  const pane = p.pane
  const pic = programIcon(p, t.dim)
  return h_flex()
    .id(`pane-head-${pane}`)
    .size_full()
    .pl(5)
    .pr(8)
    .pt(INSET)
    .gap(8)
    .items_center()
    .bg(t.background)
    .text_size(TEXT)
    .on_click(() => run("pane.focus", { pane }))
    .when(pic !== null, (el) => el.child(pic))
    .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(paneName(p)))
    .child(div().flex_1().truncate().text_color(t.dim).child(shortFolder(p.cwd, home)))
    .when(p.status === "working", (el) =>
      el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)),
    )
    .when(p.status === "blocked", (el) =>
      el.child(
        div()
          .flex_none()
          .px(6)
          .h(18)
          .flex()
          .items_center()
          .rounded(5)
          .bg(`${t.blocked}26` as Color)
          .text_size(SMALL)
          .font_semibold()
          .text_color(t.blocked)
          .child("Needs you"),
      ),
    )
    .when(p.status === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
    .when(p.focused, (el) =>
      el
        .child(button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(button(t, `ph-x-${pane}`, "close", "pane.close", { pane })),
    )
}
