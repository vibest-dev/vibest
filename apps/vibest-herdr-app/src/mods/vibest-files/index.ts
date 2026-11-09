import { Editor, h_flex, h_resizable, resizable_panel, v_flex } from "gpui-base"
import { type AsyncContext, type Context, div, type Element, svg, View } from "gpui-kit"
import { readTextFile } from "herdr"

import { iconButton } from "../../shared/icon-button.ts"
import { liveMetrics } from "../../shared/live-metrics.ts"
import { SMALL, TEXT } from "../../shared/metrics.ts"
import { type Theme, themeColors } from "../../shared/theme-colors.ts"
import { editorState, type Loaded } from "./editor.ts"
import { Folder } from "./folder.ts"
import { closeFile, EMPTY_TABS, fileName, openFile, selectFile, type ViewerFile, type ViewerTabs } from "./tabs.ts"
import { PER_FOLDER, TOTAL } from "./tree.ts"

export default class Files extends View {
  folder: Folder
  tabs: ViewerTabs
  treeOpen: boolean
  loaded: Map<string, Loaded>

  init(_props: unknown, cx: AsyncContext): void {
    this.folder = new Folder()
    this.tabs = EMPTY_TABS
    this.treeOpen = true
    this.loaded = new Map()
    this.folder.refresh(cx)
    cx.timer.every(10000, (ticked) => this.folder.refresh(ticked))
  }

  close(): void {
    for (const l of this.loaded.values()) l.state?.release()
  }

  load(file: ViewerFile, cx: Context): void {
    const loaded: Loaded = { state: null, message: "Loading file…" }
    this.loaded.set(file.path, loaded)
    cx.spawn(async (spawned) => {
      try {
        const text = await readTextFile(file.path, { on: file.on })
        if (this.loaded.get(file.path) !== loaded) return
        if (text === null) loaded.message = "This file is no longer available"
        else if (text.includes("\0")) loaded.message = "Binary file · no text preview"
        else loaded.state = editorState(file.path, text)
      } catch {
        loaded.message = "Cannot preview this file (binary, too large, or unreadable)"
      } finally {
        spawned.notify()
      }
    })
  }

  setTabs(next: ViewerTabs, cx: Context): void {
    const open = new Set(next.files.map((f) => f.path))
    for (const [path, l] of this.loaded)
      if (!open.has(path)) {
        l.state?.release()
        this.loaded.delete(path)
      }
    for (const f of next.files) if (!this.loaded.has(f.path)) this.load(f, cx)
    this.tabs = next
    cx.notify()
  }

  header(t: Theme): Element {
    const tabs = this.tabs
    const strip = h_flex()
      .id("files-tabs")
      .flex_1()
      .min_w(0)
      .h_full()
      .gap(2)
      .items_center()
      .overflow_x_scroll()
      .when(tabs.files.length === 0, (el) => el.child(div().px(4).font_medium().child("Files")))
      .children(
        tabs.files.map((f, i) => {
          const active = f.path === tabs.active
          return h_flex()
            .id(`ft-${i}`)
            .flex_none()
            .h(24)
            .pl(8)
            .pr(4)
            .gap(4)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .when(active, (el) => el.bg(t.hover))
            .text_color(active ? t.foreground : t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.setTabs(selectFile(this.tabs, f.path), cx))
            .child(div().max_w(180).truncate().child(fileName(f.path)))
            .child(
              div()
                .id(`ft-x-${i}`)
                .flex_none()
                .p(2)
                .rounded(4)
                .text_color(t.dim)
                .hover((s) => s.bg(t.border).text_color(t.foreground))
                .on_click((_e, cx) => {
                  cx.stop_propagation()
                  this.setTabs(closeFile(this.tabs, f.path), cx)
                })
                .child(svg("mods/pane/close.svg").size(12)),
            )
        }),
      )
    return h_flex()
      .h(liveMetrics().head)
      .flex_none()
      .px(6)
      .gap(4)
      .items_center()
      .child(strip)
      .child(
        iconButton(
          t,
          "files-tree-toggle",
          `mods/vibest-files/panel-right-${this.treeOpen ? "close" : "open"}.svg`,
          (cx) => {
            this.treeOpen = !this.treeOpen
            cx.notify()
          },
          { size: 22 },
        ),
      )
  }

  content(t: Theme): Element {
    const active = this.loaded.get(this.tabs.active)
    return active?.state
      ? Editor.new(active.state).size_full()
      : div()
          .size_full()
          .p(12)
          .text_color(t.dim)
          .child(active?.message ?? "Open a file from the tree")
  }

  rows(prefix: string, depth: number, out: Element[], t: Theme): Element[] {
    if (out.length >= TOTAL || depth > 40) return out
    const folder = this.folder
    for (const entry of folder.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const open = folder.open.has(path)
      const mark = folder.marks[`${folder.where.cwd}/${path}`]
      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(28)
          .flex_none()
          .pl(8 + depth * 18)
          .pr(8)
          .gap(7)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) =>
            entry.dir
              ? folder.toggle(path, cx)
              : this.setTabs(openFile(this.tabs, { path: `${folder.where.cwd}/${path}`, on: folder.where.on }), cx),
          )
          .child(
            entry.dir
              ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`)
                  .size(12)
                  .flex_none()
                  .text_color(t.dim)
              : div().w(12).flex_none(),
          )
          .child(
            svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`)
              .size(14)
              .flex_none()
              .text_color(t.muted),
          )
          .child(div().flex_1().min_w(0).truncate().child(entry.name))
          .when(Boolean(mark), (el) =>
            el.child(
              div()
                .text_size(SMALL)
                .text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked)
                .child(mark),
            ),
          ),
      )
      if (entry.dir && open) this.rows(path, depth + 1, out, t)
    }
    return out
  }

  render(cx: Context): Element {
    const folder = this.folder
    if (folder.moved()) folder.refresh(cx)
    const t = themeColors()
    const empty = folder.error || (folder.loading ? "Loading files…" : folder.where.cwd ? "No files" : "No folder")
    const tree = v_flex()
      .id("files-tree")
      .size_full()
      .overflow_y_scrollbar()
      .p(6)
      .children(this.rows("", 0, [], t))
      .when(Boolean(folder.error) || !folder.entries.get("")?.length, (el) =>
        el.child(div().p(8).text_size(TEXT).text_color(t.dim).child(empty)),
      )
      .when(folder.limited, (el) =>
        el.child(
          div()
            .p(8)
            .text_size(TEXT)
            .text_color(t.dim)
            .child(`File list limited to ${PER_FOLDER} entries per folder and ${TOTAL.toLocaleString("en-US")} total`),
        ),
      )
    return v_flex()
      .id("files")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(TEXT)
      .child(this.header(t))
      .child(
        h_resizable("vibest-files-body")
          .flex_1()
          .min_h(0)
          .child(resizable_panel().child(this.content(t)))
          .when(this.treeOpen, (el) => el.child(resizable_panel().size(220).size_range(140, 520).child(tree))),
      )
  }
}
