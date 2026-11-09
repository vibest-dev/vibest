import { h_flex } from "gpui-base"
import { div, type Element, svg, View } from "gpui-kit"
import { focused, layout, panes, run, spaces, window } from "herdr"

import { type Theme, themeColors } from "../shared/theme.ts"
import { threadTitle } from "../shared/thread-title.ts"
import { icon, iconButton, TRAFFIC_LIGHTS_INSET } from "../shared/ui.ts"

interface LayoutNode {
  readonly id?: string
  readonly hidden?: boolean
  readonly active?: string
  readonly children?: readonly LayoutNode[]
}

const find = (node: LayoutNode | undefined, id: string): LayoutNode | undefined => {
  if (node?.id === id) return node
  for (const child of node?.children ?? []) {
    const found = find(child, id)
    if (found) return found
  }
  return undefined
}

const RIGHT_PANEL = "right-panel"

const panelButton = (t: Theme, root: LayoutNode | undefined, child: string, name: string): Element => {
  const panel = find(root, RIGHT_PANEL)
  const on = Boolean(panel && !panel.hidden && panel.active === child)
  return iconButton(
    t,
    `panel-${child}`,
    name,
    () => {
      if (on) return run("layout.hide", { id: RIGHT_PANEL })
      run("layout.select", { stack: RIGHT_PANEL, child })
      run("layout.show", { id: RIGHT_PANEL })
    },
    { on },
  )
}

const topbar = (t: Theme): Element => {
  const w = window()
  const root = layout() as LayoutNode | undefined
  const space = spaces().find((s) => s.active)
  const tab = space?.tabs.find((c) => c.active)
  const tabPanes = tab ? panes().filter((p) => p.tab === tab.id) : []
  const pane = focused()?.pane
  const zoomed = Boolean(tab?.zoomed)
  const inset = w?.platform === "macos" && !w.fullscreen && find(root, "sidebar")?.hidden ? TRAFFIC_LIGHTS_INSET : 12
  return h_flex()
    .size_full()
    .min_w(0)
    .pl(inset)
    .pr(12)
    .gap(12)
    .items_center()
    .bg(t.background)
    .text_size(14)
    .font_medium()
    .child(
      h_flex()
        .flex_1()
        .min_w(0)
        .gap(8)
        .items_center()
        .when(space !== undefined, (el) =>
          el
            .child(svg(icon("folder")).size(14).flex_none().text_color(t.muted))
            .child(div().flex_none().max_w(160).truncate().text_color(t.muted).child(space?.name))
            .child(div().flex_none().text_color(t.dim).child("/"))
            .child(
              div()
                .min_w(0)
                .truncate()
                .text_color(t.foreground)
                .child(tab ? threadTitle(tab, tabPanes) : ""),
            )
            .when(Boolean(space?.branch), (el) =>
              el.child(
                h_flex()
                  .flex_none()
                  .h(20)
                  .px(6)
                  .gap(4)
                  .items_center()
                  .rounded(6)
                  .border(1)
                  .border_color(t.border)
                  .text_size(12)
                  .font_weight(400)
                  .text_color(t.muted)
                  .child(svg(icon("git-branch")).size(12))
                  .child(div().max_w(160).truncate().child(space?.branch)),
              ),
            ),
        ),
    )
    .child(
      h_flex()
        .flex_none()
        .gap(4)
        .items_center()
        .child(
          iconButton(t, "split", "terminal", () =>
            run("pane.split", { direction: "right", ...(pane ? { pane } : {}) }),
          ),
        )
        .child(panelButton(t, root, "files", "files"))
        .child(panelButton(t, root, "changes", "git-compare"))
        .child(panelButton(t, root, "agents", "monitor"))
        .child(
          iconButton(t, "zoom", zoomed ? "minus" : "square", () => run("pane.zoom", pane ? { pane } : {}), {
            on: zoomed,
          }),
        )
        .when(Boolean(w?.buttons), (el) =>
          el
            .child(iconButton(t, "minimize", "minus", () => run("window.minimize")))
            .child(iconButton(t, "maximize", "square", () => run("window.maximize")))
            .child(iconButton(t, "close-window", "x", () => run("window.close"))),
        ),
    )
}

export default class Topbar extends View {
  render(): Element {
    return topbar(themeColors())
  }
}
