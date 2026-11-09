import { h_flex } from "gpui-base"
import { div, type Element, svg } from "gpui-kit"
import { run } from "herdr"

import { icon, iconButton } from "../../shared/icon-button.ts"
import { TEXT, SMALL } from "../../shared/text-size.ts"
import type { Theme } from "../../shared/theme-colors.ts"
import { type Breadcrumb, RIGHT_PANEL, type TopbarState } from "./topbar-state.ts"

export interface TopbarWindow {
  readonly inset: number
  readonly buttons: boolean
}

const panelButton = (t: Theme, shown: string | null, child: string, name: string): Element => {
  const on = shown === child
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

const branchChip = (t: Theme, branch: string): Element =>
  h_flex()
    .flex_none()
    .h(20)
    .px(6)
    .gap(4)
    .items_center()
    .rounded(6)
    .border(1)
    .border_color(t.border)
    .text_size(SMALL)
    .font_weight(400)
    .text_color(t.muted)
    .child(svg(icon("git-branch")).size(12))
    .child(div().max_w(160).truncate().child(branch))

const breadcrumbView = (t: Theme, crumb: Breadcrumb): Element =>
  h_flex()
    .flex_1()
    .min_w(0)
    .gap(8)
    .items_center()
    .child(svg(icon("folder")).size(14).flex_none().text_color(t.muted))
    .child(div().flex_none().max_w(160).truncate().text_color(t.muted).child(crumb.project))
    .child(div().flex_none().text_color(t.dim).child("/"))
    .child(div().min_w(0).truncate().text_color(t.foreground).child(crumb.thread))
    .when(crumb.branch !== null && crumb.branch !== "", (el) => el.child(branchChip(t, crumb.branch)))

export const topbarView = (t: Theme, state: TopbarState, win: TopbarWindow): Element =>
  h_flex()
    .w_full()
    .h(32)
    .min_w(0)
    .pl(win.inset)
    .pt(8)
    .gap(12)
    .items_center()
    .bg(t.chrome)
    .text_size(TEXT)
    .font_medium()
    .when(state.sidebarHidden, (el) =>
      el.child(
        iconButton(t, "toggle-sidebar", "mods/vibest-topbar/panel-left-open.svg", () =>
          run("layout.toggle", { id: "sidebar" }),
        ),
      ),
    )
    .child(state.breadcrumb ? breadcrumbView(t, state.breadcrumb) : div().flex_1())
    .child(
      h_flex()
        .flex_none()
        .gap(4)
        .items_center()
        .child(panelButton(t, state.shownPanel, "files", "files"))
        .child(panelButton(t, state.shownPanel, "changes", "git-compare"))
        .child(panelButton(t, state.shownPanel, "agents", "monitor"))
        .when(win.buttons, (el) =>
          el
            .child(iconButton(t, "minimize", "minus", () => run("window.minimize")))
            .child(iconButton(t, "maximize", "square", () => run("window.maximize")))
            .child(iconButton(t, "close-window", "x", () => run("window.close"))),
        ),
    )
