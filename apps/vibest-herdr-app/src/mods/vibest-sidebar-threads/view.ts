import { h_flex, v_flex } from "gpui-base"
import { type Context, div, type Element, svg } from "gpui-kit"
import { openOverlay, pickFolder, run } from "herdr"

import { icon, iconButton } from "../../shared/icon-button.ts"
import { liveMetrics } from "../../shared/live-metrics.ts"
import { CONTROL, SMALL, TEXT } from "../../shared/metrics.ts"
import type { Theme } from "../../shared/theme-colors.ts"
import { elapsed, pill, type Project, relativeTime, type Thread } from "./projects.ts"

export interface ThreadsUi {
  readonly hovered: string | null
  readonly folded: ReadonlySet<string>
  readonly now: number
  hover(id: string): (on: boolean, cx: Context) => void
  fold(id: string): void
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

  status(thread: Thread): Element {
    const t = this.t
    const p = pill(thread.status)
    if (!p) return div().text_size(TEXT).text_color(t.dim).child(relativeTime(thread.changedAt, this.ui.now))
    const color = t[p.tone]
    const dot = div().size(6).flex_none().rounded_full().bg(color)
    const since = thread.status === "working" ? elapsed(thread.workingSince, this.ui.now) : ""
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
      .h(36)
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
        div().flex_1().min_w(0).truncate().text_size(TEXT).font_medium().text_color(t.foreground).child(thread.title),
      )
      .child(h_flex().h(24).min_w(32).flex_none().justify_end().items_center().child(this.status(thread)))
  }

  projectRow(project: Project): Element {
    const t = this.t
    const id = `project-${project.id}`
    const folded = this.ui.folded.has(project.id)
    const hovered = this.ui.hovered === id
    const tone = project.status && project.status !== "idle" ? t[project.status] : null
    return h_flex()
      .id(id)
      .h(32)
      .mt(8)
      .px(10)
      .gap(10)
      .items_center()
      .rounded(8)
      .flex_none()
      .hover((s) => s.bg(t.hover))
      .cursor_pointer()
      .on_hover(this.ui.hover(id))
      .on_click((_e, cx) => {
        this.ui.fold(project.id)
        cx.notify()
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
      .child(svg(icon("folder")).size(16).flex_none().text_color(t.muted))
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
        el.child(div().flex_none().text_size(TEXT).text_color(t.dim).child(project.machine)),
      )
      .when(folded && tone !== null && !hovered, (el) => el.child(div().size(6).flex_none().rounded_full().bg(tone)))
      .when(folded && !hovered, (el) =>
        el.child(div().flex_none().text_size(TEXT).text_color(t.dim).child(String(project.threads.length))),
      )
      .when(hovered, (el) =>
        el.child(
          iconButton(t, `new-${project.id}`, "square-pen", () => run("tab.new", { space: project.id }), { size: 24 }),
        ),
      )
      .child(
        svg(icon(folded ? "chevron-right" : "chevron-down"))
          .size(12)
          .flex_none()
          .text_color(t.muted),
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
      .overflow_y_scrollbar()
      .children(
        all.flatMap((project) => [
          this.projectRow(project),
          ...(this.ui.folded.has(project.id) ? [] : project.threads.map((thread) => this.threadRow(project, thread))),
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
