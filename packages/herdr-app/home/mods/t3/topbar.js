import { h_flex } from "gpui-base"
import { div, svg } from "gpui-kit"
import { spaces, panes, focused, run, theme, window, layout } from "herdr"

import { threadTitle } from "./model.js"

const ICON = (name) => `mods/workspace-chrome/${name}.svg`
const TRAFFIC_LIGHTS_INSET = 90

function find(node, id) {
  if (node?.id === id) return node
  for (const child of node?.children ?? []) {
    const found = find(child, id)
    if (found) return found
  }
  return null
}

export class Topbar {
  button(t, id, icon, on, action) {
    return div()
      .id(id)
      .size(28)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(8)
      .bg(on ? t.selected : t.background)
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation()
        action()
      })
      .child(svg(icon).size(16))
  }

  panelButton(t, root, child, icon) {
    const panel = find(root, "panel")
    const on = Boolean(panel && !panel.hidden && find(root, "panel-body")?.active === child)
    return this.button(t, `panel-${child}`, icon, on, () => {
      if (on) return run("layout.hide", { id: "panel" })
      run("layout.select", { stack: "panel-body", child })
      run("layout.show", { id: "panel" })
    })
  }

  render() {
    const t = theme()
    const w = window()
    const root = layout()
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
          .when(Boolean(space), (el) =>
            el
              .child(svg(ICON("folder")).size(14).flex_none().text_color(t.muted))
              .child(div().flex_none().max_w(160).truncate().text_color(t.muted).child(space.name))
              .child(div().flex_none().text_color(t.dim).child("/"))
              .child(
                div()
                  .min_w(0)
                  .truncate()
                  .text_color(t.foreground)
                  .child(tab ? threadTitle(tab, tabPanes) : ""),
              )
              .when(Boolean(space.branch), (el) =>
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
                    .child(svg(ICON("git-branch")).size(12))
                    .child(div().max_w(160).truncate().child(space.branch)),
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
            this.button(t, "split", ICON("terminal"), false, () =>
              run("pane.split", { direction: "right", ...(pane ? { pane } : {}) }),
            ),
          )
          .child(this.panelButton(t, root, "files", ICON("files")))
          .child(this.panelButton(t, root, "changes", ICON("git-compare")))
          .child(
            this.button(t, "zoom", ICON(zoomed ? "minus" : "square"), zoomed, () =>
              run("pane.zoom", pane ? { pane } : {}),
            ),
          )
          .when(Boolean(w?.buttons), (el) =>
            el
              .child(this.button(t, "minimize", ICON("minus"), false, () => run("window.minimize")))
              .child(this.button(t, "maximize", ICON("square"), false, () => run("window.maximize")))
              .child(this.button(t, "close-window", ICON("x"), false, () => run("window.close"))),
          ),
      )
  }
}
