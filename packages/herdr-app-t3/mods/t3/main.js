import { h_flex, v_flex } from "gpui-base"
import { View, div, svg } from "gpui-kit"
import { spaces, panes, run, theme, props, window, openOverlay, pickFolder, updates } from "herdr"

import { elapsed, pill, projects, relativeTime } from "./model.js"
import { Topbar } from "./topbar.js"

const ICON = (name) => `mods/workspace-chrome/${name}.svg`
const TRAFFIC_LIGHTS_INSET = 90
const CLOCK_MS = 30000

export default class T3 extends View {
  init(_props, cx) {
    this.hovered = null
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"))
    this.now = Date.now()
    if (props()?.part === undefined)
      cx.timer.every(CLOCK_MS, (cx) => {
        this.now = Date.now()
        cx.notify()
      })
  }

  hover(id) {
    return (on, cx) => {
      if (on) this.hovered = id
      else if (this.hovered === id) this.hovered = null
      cx.notify()
    }
  }

  fold(id) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id)
    localStorage.setItem("folded", JSON.stringify([...this.folded]))
  }

  iconButton(t, id, icon, action, size = 28) {
    return div()
      .id(id)
      .size(size)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(8)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation()
        action(cx)
      })
      .child(svg(ICON(icon)).size(16))
  }

  header(t) {
    const w = window()
    const inset = w?.platform === "macos" && !w.fullscreen ? TRAFFIC_LIGHTS_INSET : 16
    return h_flex()
      .size_full()
      .pl(inset)
      .pr(12)
      .items_center()
      .gap(4)
      .bg(t.chrome)
      .text_size(14)
      .child(div().font_medium().text_color(t.foreground).child("Herdr"))
  }

  footer(t) {
    const ready = Boolean(updates()?.app?.ready)
    return h_flex()
      .size_full()
      .px(8)
      .pt(4)
      .pb(8)
      .gap(4)
      .items_center()
      .bg(t.chrome)
      .child(
        h_flex()
          .relative()
          .child(this.iconButton(t, "settings", "settings", () => run("app.settings"), 32))
          .when(ready, (el) => el.child(div().absolute().top(6).right(6).size(6).rounded_full().bg(t.accent))),
      )
      .child(this.iconButton(t, "add-machine", "server", () => run("mod.open", { name: "machine-add" }), 32))
      .child(div().flex_1())
      .child(this.iconButton(t, "palette", "layers", () => run("app.palette"), 32))
  }

  toolbar(t) {
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
          .child(svg(ICON("search")).size(16))
          .child("Search"),
      )
      .when(spaces().length > 0, (el) =>
        el.child(this.iconButton(t, "add-project", "folder-plus", (cx) => this.addProject(cx))),
      )
      .child(this.iconButton(t, "new-thread", "square-pen", () => run("tab.new", active ? { space: active.id } : {})))
  }

  addProject(cx) {
    cx.spawn(async () => {
      const folder = await pickFolder({ prompt: "Add project" })
      if (folder) run("space.new", { folder })
    })
  }

  status(t, thread) {
    const p = pill(thread.status)
    if (!p) return div().text_size(12).text_color(t.dim).child(relativeTime(thread.changedAt, this.now))
    const color = t[p.tone] ?? t.unknown
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

  threadRow(t, project, thread) {
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

  projectRow(t, project) {
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
      .child(svg(ICON("folder")).size(16).flex_none().text_color(t.muted))
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
      .when(folded && Boolean(tone) && !hovered, (el) => el.child(div().size(6).flex_none().rounded_full().bg(tone)))
      .when(folded && !hovered, (el) =>
        el.child(div().flex_none().text_size(12).text_color(t.dim).child(String(project.threads.length))),
      )
      .when(hovered, (el) =>
        el.child(
          this.iconButton(t, `new-${project.id}`, "square-pen", () => run("tab.new", { space: project.id }), 24),
        ),
      )
      .child(
        svg(ICON(folded ? "chevron-right" : "chevron-down"))
          .size(12)
          .flex_none()
          .text_color(t.muted),
      )
  }

  list(t) {
    const all = projects(spaces(), panes())
    if (!all.length) {
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
    }
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

  render() {
    const t = theme()
    const part = props()?.part
    if (part === "header") return this.header(t)
    if (part === "footer") return this.footer(t)
    if (part === "topbar") return (this.topbar ??= new Topbar()).render()
    return v_flex().size_full().bg(t.chrome).child(this.toolbar(t)).child(this.list(t))
  }
}
