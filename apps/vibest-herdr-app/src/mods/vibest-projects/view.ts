import { h_flex, v_flex } from "gpui-base"
import { type Context, div, type Element, svg } from "gpui-kit"

import { icon } from "../../shared/icon-button.ts"
import type { MachineMember, ProjectGroup } from "../../shared/project-groups.ts"
import { openProject, statusMark } from "../../shared/session-ui.ts"
import { SMALL, TEXT } from "../../shared/text-size.ts"
import type { Theme } from "../../shared/theme-colors.ts"
import { LOCAL } from "../../shared/vibest-model.ts"

export interface ProjectsUi {
  readonly hovered: string | null
  readonly now: number
  readonly selected: string | null
  hover(id: string): (on: boolean, cx: Context) => void
}

const ROW = 32
const HEADER = 32
const BOTTOM = 16
const MACHINE_INDENT = 16
const MARK = 16
const MACHINE_ICON = 16

const showMachines = (g: ProjectGroup): boolean => g.members.length > 1 || g.members[0]?.machine !== LOCAL

export class ProjectsView {
  constructor(
    readonly t: Theme,
    readonly ui: ProjectsUi,
  ) {}

  row(id: string, height: number, indent: number, on: boolean, onClick: (cx: Context) => void): Element {
    const t = this.t

    return h_flex()
      .id(id)
      .h(height)
      .pl(8 + indent)
      .pr(8)
      .gap(8)
      .items_center()
      .rounded(8)
      .flex_none()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .cursor_pointer()
      .on_click((_, cx) => onClick(cx))
      .on_hover(this.ui.hover(id))
  }

  title(text: string, strong: boolean): Element {
    return div()
      .flex_1()
      .min_w(0)
      .truncate()
      .text_size(TEXT())
      .text_color(strong ? this.t.foreground : this.t.muted)
      .child(text)
  }

  machineRow(g: ProjectGroup, m: MachineMember): Element {
    const main = m.main

    return this.row(`machine-${m.machine}-${m.project.id}`, ROW, MACHINE_INDENT, false, (cx) =>
      openProject(g.key, g.label, m, cx),
    )
      .child(
        svg(icon(m.machine === LOCAL ? "monitor" : "server"))
          .size(MACHINE_ICON)
          .flex_none()
          .text_color(this.t.muted),
      )
      .child(this.title(m.machine === LOCAL ? "This machine" : m.machine, false))
      .child(statusMark(this.t, m.activity, main?.lastActive ?? null, this.ui.now))
  }

  groupRows(g: ProjectGroup): Element[] {
    const t = this.t
    const first = g.members[0]
    const main = first?.main ?? null

    const head = this.row(`group-${g.key}`, ROW, 0, this.ui.selected === g.key, (cx) => {
      if (first) openProject(g.key, g.label, first, cx)
    })
      .child(
        h_flex()
          .size(MARK)
          .flex_none()
          .items_center()
          .justify_center()
          .child(svg(icon("mods/vibest-projects/project.svg")).size(MARK).text_color(t.muted)),
      )
      .child(this.title(g.label, true))
      .child(statusMark(t, g.activity, main?.lastActive ?? null, this.ui.now))

    return showMachines(g) ? [head, ...g.members.map((m) => this.machineRow(g, m))] : [head]
  }

  render(groups: readonly ProjectGroup[], note: string): Element {
    const t = this.t

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .child(
        h_flex()
          .h(HEADER)
          .px(12)
          .flex_none()
          .items_center()
          .text_size(SMALL())
          .text_color(t.dim)
          .gap(8)
          .child(div().flex_none().child("Projects"))
          .child(div().flex_1().min_w(0).truncate().text_right().child(note)),
      )
      .child(
        v_flex()
          .id("projects")
          .flex_1()
          .min_h(0)
          .px(4)
          .pb(BOTTOM)
          .overflow_y_scrollbar()
          .when(groups.length === 0, (el) =>
            el.child(div().px(8).pt(8).text_size(TEXT()).text_color(t.muted).child("No vibest projects yet.")),
          )
          .children(groups.flatMap((g) => this.groupRows(g))),
      )
  }
}
