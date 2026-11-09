import { h_flex, v_flex } from "gpui-base"
import { div, svg } from "gpui-kit"
import { openOverlay, panes, pickFolder, run, spaces, type Theme } from "herdr"

import { icon, iconButton } from "../ui.ts"
import { elapsed, parseFolded, pill, type Project, projects, relativeTime, type Thread } from "./model.ts"

const CLOCK_MS = 30000

export class ThreadList {
  hovered: string | null = null
  folded = new Set(parseFolded(localStorage.getItem("folded")))
  now = Date.now()

  constructor(cx: Cx) {
    cx.timer.every(CLOCK_MS, (ticked) => {
      this.now = Date.now()
      ticked.notify()
    })
  }

  hover(id: string) {
    return (on: boolean, cx: Cx) => {
      if (on) this.hovered = id
      else if (this.hovered === id) this.hovered = null
      cx.notify()
    }
  }

  fold(id: string): void {
    if (this.folded.has(id)) this.folded.delete(id)
    else this.folded.add(id)
    localStorage.setItem("folded", JSON.stringify([...this.folded]))
  }

  toolbar(t: Theme): Chain {
    const active = spaces().find((s) => s.active)
    return h_flex()
      .px(8)
      .pb(8)
      .gap(4)
      .items_center()
      .flex_none()
      .child(
        h_flex()
          .id("search")
          .flex_1()
          .h(32)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(6)
          .text_size(14)
          .font_medium()
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover))
          .cursor_pointer()
          .on_click(() => run("mod.open", { name: "picker" }))
          .child(svg(icon("search")).size(16))
          .child("Search"),
      )
      .when(spaces().length > 0, (el) =>
        el.child(iconButton(t, "add-project", "folder-plus", (cx) => this.addProject(cx))),
      )
      .child(iconButton(t, "new-thread", "square-pen", () => run("tab.new", active ? { space: active.id } : {})))
  }

  addProject(cx: Cx): void {
    cx.spawn(async () => {
      const folder = await pickFolder({ prompt: "Add project" })
      if (folder) run("space.new", { folder })
    })
  }

  status(t: Theme, thread: Thread): Chain {
    const p = pill(thread.status)
    if (!p) return div().text_size(12).text_color(t.dim).child(relativeTime(thread.changedAt, this.now))
    const color = t[p.tone]
    const dot = div().size(6).flex_none().rounded_full().bg(color)
    const since = thread.status === "working" ? elapsed(thread.workingSince, this.now) : ""
    return h_flex()
      .gap(6)
      .items_center()
      .text_size(12)
      .font_medium()
      .text_color(color)
      .child(p.pulse ? dot.loop("opacity", { from: 0.5, to: 1, period: 2000 }) : dot)
      .child(since ? `${p.label} ${since}` : p.label)
  }

  threadRow(t: Theme, project: Project, thread: Thread): Chain {
    const id = `thread-${thread.id}`
    return h_flex()
      .id(id)
      .h(36)
      .pl(36)
      .pr(10)
      .gap(10)
      .items_center()
      .rounded(6)
      .flex_none()
      .border(1)
      .border_color(thread.active ? t.border : t.chrome)
      .bg(thread.active ? t.selected : t.chrome)
      .hover((s) => s.bg(thread.active ? t.selected : t.hover))
      .cursor_pointer()
      .on_hover(this.hover(id))
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
        div().flex_1().min_w(0).truncate().text_size(14).font_medium().text_color(t.foreground).child(thread.title),
      )
      .child(h_flex().h(24).min_w(32).flex_none().justify_end().items_center().child(this.status(t, thread)))
  }

  projectRow(t: Theme, project: Project): Chain {
    const id = `project-${project.id}`
    const folded = this.folded.has(project.id)
    const hovered = this.hovered === id
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
      .on_hover(this.hover(id))
      .on_click((_e, cx) => {
        this.fold(project.id)
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
          .text_size(14)
          .font_medium()
          .text_color(project.active ? t.foreground : t.muted)
          .child(project.name),
      )
      .when(Boolean(project.machine), (el) =>
        el.child(div().flex_none().text_size(12).text_color(t.dim).child(project.machine)),
      )
      .when(folded && tone !== null && !hovered, (el) =>
        el.child(
          div()
            .size(6)
            .flex_none()
            .rounded_full()
            .bg(tone ?? ""),
        ),
      )
      .when(folded && !hovered, (el) =>
        el.child(div().flex_none().text_size(12).text_color(t.dim).child(String(project.threads.length))),
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

  list(t: Theme): Chain {
    const all = projects(spaces(), panes())
    if (!all.length)
      return v_flex()
        .flex_1()
        .px(18)
        .pt(16)
        .gap(4)
        .text_size(12)
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
      .px(8)
      .pb(8)
      .overflow_y_scrollbar()
      .children(
        all.flatMap((project) => [
          this.projectRow(t, project),
          ...(this.folded.has(project.id) ? [] : project.threads.map((thread) => this.threadRow(t, project, thread))),
        ]),
      )
  }

  render(t: Theme): Chain {
    return v_flex().size_full().bg(t.chrome).child(this.toolbar(t)).child(this.list(t))
  }
}
