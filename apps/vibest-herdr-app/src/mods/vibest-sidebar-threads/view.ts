import { h_flex, v_flex } from "gpui-base"
import { type Context, div, type Element, svg } from "gpui-kit"
import { openOverlay, pickFolder, run, type Status } from "herdr"

import { icon, iconButton } from "../../shared/icon-button.ts"
import { liveMetrics } from "../../shared/live-metrics.ts"
import { CONTROL, SMALL, TEXT } from "../../shared/metrics.ts"
import type { Theme } from "../../shared/theme-colors.ts"
import { elapsed, pill, type Project, relativeTime, type Thread } from "./projects.ts"

export interface ThreadsUi {
  readonly hovered: string | null
  readonly expanded: ReadonlySet<string>
  readonly now: number
  hover(id: string): (on: boolean, cx: Context) => void
  toggle(id: string): void
}

export class ThreadsView {
  constructor(
    readonly t: Theme,
    readonly ui: ThreadsUi,
  ) {}

  toolbar(projects: readonly Project[]): Element {
    const t = this.t
    const active = projects.find((p) => p.active)

    return h_flex()
      .pr(12)
      .pt(liveMetrics().searchTop)
      .pb(8)
      .gap(4)
      .items_center()
      .flex_none()
      .child(
        h_flex()
          .id("search")
          .flex_1()
          .h(CONTROL)
          .px(10)
          .gap(8)
          .items_center()
          .rounded(6)
          .text_size(TEXT)
          .font_medium()
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover))
          .cursor_pointer()
          .on_click(() => run("mod.open", { name: "picker" }))
          .child(svg(icon("search")).size(16))
          .child("Search"),
      )
      .when(projects.length > 0, (el) => el.child(iconButton(t, "add-project", "folder-plus", (cx) => addProject(cx))))
      .child(iconButton(t, "new-thread", "square-pen", () => run("tab.new", active ? { space: active.id } : {})))
  }

  status(status: Status | null, changedAt: number | null, workingSince: number | null): Element {
    const t = this.t
    const p = pill(status)

    if (!p) return div().text_size(SMALL).text_color(t.dim).child(relativeTime(changedAt, this.ui.now))

    const color = t[p.tone]
    const dot = div().size(6).flex_none().rounded_full().bg(color)
    const since = status === "working" ? elapsed(workingSince, this.ui.now) : ""

    return h_flex()
      .gap(6)
      .items_center()
      .text_size(SMALL)
      .font_medium()
      .text_color(color)
      .child(p.pulse ? dot.loop("opacity", { from: 0.5, to: 1, period: 2000 }) : dot)
      .child(since ? `${p.label} ${since}` : p.label)
  }

  threadRow(project: Project, thread: Thread): Element {
    const t = this.t
    const id = `thread-${thread.id}`

    return h_flex()
      .id(id)
      .h(32)
      .pl(36)
      .pr(10)
      .gap(10)
      .items_center()
      .rounded(10)
      .flex_none()
      .border(1)
      .border_color(thread.active ? t.border : t.chrome)
      .bg(thread.active ? t.selected : t.chrome)
      .hover((s) => s.bg(thread.active ? t.selected : t.hover))
      .cursor_pointer()
      .on_hover(this.ui.hover(id))
      .on_click(() => {
        run("space.select", { id: project.id })
        run("tab.select", { id: thread.id })
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation()
        openOverlay({
          mod: "menu",
          kind: "popup",
          width: 200,
          props: { tab: "tab", target: { id: thread.id, space: project.id } },
        })
      })
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(TEXT)
          .font_medium()
          .text_color(thread.active ? t.foreground : t.muted)
          .child(thread.title),
      )
      .child(
        h_flex()
          .h(24)
          .min_w(32)
          .flex_none()
          .justify_end()
          .items_center()
          .child(this.status(thread.status, thread.changedAt, thread.workingSince)),
      )
  }

  projectRow(project: Project): Element {
    const t = this.t
    const id = `project-${project.id}`
    const hasMultiple = project.threads.length > 1
    const expanded = hasMultiple && this.ui.expanded.has(project.id)
    const hovered = this.ui.hovered === id
    const highlighted = project.active && !expanded

    return h_flex()
      .id(id)
      .h(36)
      .px(10)
      .gap(8)
      .items_center()
      .rounded(10)
      .flex_none()
      .border(1)
      .border_color(highlighted ? t.border : t.chrome)
      .bg(highlighted ? t.selected : t.chrome)
      .hover((s) => s.bg(highlighted ? t.selected : t.hover))
      .cursor_pointer()
      .on_hover(this.ui.hover(id))
      .on_click(() => {
        run("space.select", { id: project.id })

        if (project.primaryTabId) run("tab.select", { id: project.primaryTabId })
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation()
        openOverlay({
          mod: "menu",
          kind: "popup",
          width: 200,
          height: 260,
          props: { tab: "space", target: { id: project.id } },
        })
      })
      .child(
        svg(icon("folder"))
          .size(16)
          .flex_none()
          .text_color(project.active ? t.foreground : t.muted),
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(TEXT)
          .font_medium()
          .text_color(project.active ? t.foreground : t.muted)
          .child(project.name),
      )
      .when(Boolean(project.machine), (el) =>
        el.child(
          div()
            .flex_none()
            .px(6)
            .h(18)
            .flex()
            .items_center()
            .rounded(5)
            .border(1)
            .border_color(t.border)
            .text_size(SMALL)
            .text_color(t.dim)
            .child(project.machine),
        ),
      )
      .when(!hovered, (el) =>
        el.child(
          h_flex()
            .h(24)
            .flex_none()
            .justify_end()
            .items_center()
            .child(this.status(project.status, project.changedAt, project.workingSince)),
        ),
      )
      .when(hasMultiple && !expanded && !hovered, (el) =>
        el.child(div().flex_none().text_size(SMALL).text_color(t.dim).child(String(project.threads.length))),
      )
      .when(hovered, (el) =>
        el.child(
          iconButton(t, `new-${project.id}`, "square-pen", () => run("tab.new", { space: project.id }), { size: 24 }),
        ),
      )
      .when(hasMultiple, (el) =>
        el.child(
          div()
            .id(`expand-${project.id}`)
            .size(20)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(6)
            .text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
              cx.stop_propagation()
              this.ui.toggle(project.id)
              cx.notify()
            })
            .child(svg(icon(expanded ? "chevron-down" : "chevron-right")).size(12)),
        ),
      )
  }

  list(all: readonly Project[]): Element {
    const t = this.t

    if (!all.length)
      return v_flex()
        .flex_1()
        .px(18)
        .pt(16)
        .gap(4)
        .text_size(TEXT)
        .text_color(t.muted)
        .child("No projects yet.")
        .child(
          div()
            .id("empty-add")
            .text_color(t.foreground)
            .cursor_pointer()
            .on_click(() => run("space.new"))
            .child("New project"),
        )

    return v_flex()
      .id("projects")
      .flex_1()
      .min_h(0)
      .pr(8)
      .pb(8)
      .gap(2)
      .overflow_y_scrollbar()
      .children(
        all.flatMap((project) => [
          this.projectRow(project),
          ...(project.threads.length > 1 && this.ui.expanded.has(project.id)
            ? project.threads.map((thread) => this.threadRow(project, thread))
            : []),
        ]),
      )
  }

  render(projects: readonly Project[]): Element {
    return v_flex().size_full().bg(this.t.chrome).child(this.toolbar(projects)).child(this.list(projects))
  }
}

const addProject = (cx: Context): void => {
  cx.spawn(async () => {
    const folder = await pickFolder({ prompt: "Add project" })

    if (folder) run("space.new", { folder })
  })
}
