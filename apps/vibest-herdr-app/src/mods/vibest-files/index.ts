import { Editor, EditorState, h_flex, h_resizable, resizable_panel, v_flex } from "gpui-base"
import { type AsyncContext, type Context, div, type Element, svg, View } from "gpui-kit"
import { exec, focused, panes, readTextFile, settings, spaces, theme, watchFolder } from "herdr"

import { iconButton } from "../../shared/icon-button.ts"
import { type Theme, themeColors } from "../../shared/theme-colors.ts"
import {
  closeFile,
  EMPTY_TABS,
  fileName,
  openFile,
  selectFile,
  type ViewerFile,
  type ViewerTabs,
} from "../../shared/viewer-tabs.ts"

interface Entry {
  readonly name: string
  readonly dir: boolean
}

interface Where {
  readonly key: string
  readonly cwd: string | null
  readonly on: string | null
}

interface Loaded {
  state: EditorState | null
  message: string
}

const LANG: Record<string, string> = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  toml: "yaml",
  jsonc: "json",
  svelte: "html",
  vue: "html",
}

const MAX_CHARS = 400000

const editorState = (path: string, text: string): EditorState => {
  const t = theme()
  const ext = path.includes(".") ? path.split(".").pop() : "txt"
  return EditorState.new({
    language: LANG[ext] ?? ext,
    readonly: true,
    value: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… (file truncated)` : text,
    font_family: settings().font_family as string,
    font_size: 12,
    syntax: {
      keyword: t.ansi5,
      string: t.ansi2,
      comment: t.dim,
      function: t.ansi4,
      type: t.ansi3,
      number: t.ansi1,
      constant: t.ansi6,
    },
  })
}

const PER_FOLDER = 500
const TOTAL = 5000

const LIST =
  'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"'

const directory = async (path: string, on: string | null): Promise<Entry[]> => {
  const r = await exec("sh", ["-c", LIST, "files", path], { on })
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder")
  const fields = r.stdout.split("\0")
  const out: Entry[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" })
  return out
}

const gitMarks = async (cwd: string, on: string | null): Promise<Record<string, string>> => {
  const marks: Record<string, string> = {}
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch((): null => null)
  if (top?.code !== 0) return marks
  const status = await exec(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--untracked-files=all",
    ],
    { cwd, on },
  ).catch((): null => null)
  if (status?.code !== 0) return marks
  for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
    const xy = entry.slice(0, 2)
    marks[`${top.stdout.trim()}/${entry.slice(3)}`] =
      xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M"
  }
  return marks
}

export default class Files extends View {
  where: Where
  saved: Map<string, Set<string>>
  entries: Map<string, Entry[]>
  folders: Set<string>
  pending: Set<string>
  marks: Record<string, string>
  watched: string | null
  loading: boolean
  limited: boolean
  error: string | null

  tabs: ViewerTabs
  treeOpen: boolean
  loaded: Map<string, Loaded>

  init(_props: unknown, cx: AsyncContext): void {
    this.where = { key: "", cwd: null, on: null }
    this.tabs = EMPTY_TABS
    this.treeOpen = true
    this.loaded = new Map()
    this.saved = new Map()
    this.entries = new Map()
    this.folders = new Set()
    this.pending = new Set()
    this.marks = {}
    this.watched = null
    this.loading = false
    this.limited = false
    this.error = null
    this.refresh(cx)
    cx.timer.every(10000, (ticked) => this.refresh(ticked))
  }

  locate(): Where {
    const f = focused()
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null
    if (pane?.mod) return this.where
    const space = spaces().find((s) => s.active)
    const on = space?.machine ?? null
    const cwd = pane?.cwd || f?.cwd || space?.folder || null
    return { key: JSON.stringify([cwd, on, space?.id]), cwd, on }
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
    this.tabs = next
    cx.notify()
  }

  header(t: Theme): Element {
    const tabs = this.tabs
    return h_flex()
      .h(28)
      .flex_none()
      .px(6)
      .gap(2)
      .items_center()
      .overflow_hidden()
      .when(tabs.files.length === 0, (el) => el.child(div().px(4).font_medium().child("Files")))
      .children(
        tabs.files.map((f, i) => {
          const active = f.path === tabs.active
          return h_flex()
            .id(`ft-${i}`)
            .flex_none()
            .h(22)
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
      .child(div().flex_1())
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

  content(cx: Context, t: Theme): Element {
    const tabs = this.tabs
    const open = new Set(tabs.files.map((f) => f.path))
    for (const [path, l] of this.loaded)
      if (!open.has(path)) {
        l.state?.release()
        this.loaded.delete(path)
      }
    for (const f of tabs.files) if (!this.loaded.has(f.path)) this.load(f, cx)
    const active = this.loaded.get(tabs.active)
    return active?.state
      ? Editor.new(active.state).size_full()
      : div()
          .size_full()
          .p(12)
          .text_color(t.dim)
          .child(active?.message ?? "Open a file from the tree")
  }

  current(where: Where): boolean {
    return this.where === where && this.locate().key === where.key
  }

  async loadFolder(path: string, where: Where): Promise<void> {
    const entries = await directory(path ? `${where.cwd}/${path}` : where.cwd, where.on)
    if (!this.current(where) || (path && !this.folders.has(path))) return
    const used = [...this.entries].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0)
    this.entries.set(
      path,
      entries
        .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
    )
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true
  }

  watch(where: Where, cx: AsyncContext): void {
    if (where.on || this.watched === where.cwd) return
    this.watched = where.cwd
    cx.spawn(async (spawned) => {
      try {
        while (this.where === where) {
          await watchFolder(where.cwd)
          if (this.current(where)) this.refresh(spawned)
        }
      } catch {
        if (this.where === where) this.watched = null
      }
    })
  }

  refresh(cx: Context): void {
    const next = this.locate()
    if (next.key !== this.where.key) {
      if (this.where.key) this.saved.set(this.where.key, this.folders)
      this.where = next
      this.entries = new Map()
      this.folders = new Set(this.saved.get(next.key))
      this.pending = new Set()
      this.marks = {}
      this.watched = null
      this.error = null
      this.limited = false
      this.loading = false
    }
    const where = this.where
    if (!where.cwd || this.loading) return
    this.loading = true
    this.limited = false
    cx.spawn(async (spawned) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(where)) return
          await this.loadFolder(path, where)
        }
        const marks = await gitMarks(where.cwd, where.on)
        if (!this.current(where)) return
        this.marks = marks
        this.error = null
        this.watch(where, spawned)
      } catch (e) {
        if (this.current(where)) this.error = String(e)
      } finally {
        if (this.where === where) this.loading = false
        spawned.notify()
      }
    })
  }

  toggle(path: string, cx: Context): void {
    if (this.folders.has(path)) {
      for (const folder of this.folders)
        if (folder === path || folder.startsWith(`${path}/`)) {
          this.folders.delete(folder)
          this.entries.delete(folder)
        }
    } else {
      this.folders.add(path)
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const where = this.where
        this.pending.add(path)
        cx.spawn(async (spawned) => {
          try {
            await this.loadFolder(path, where)
          } catch (e) {
            if (this.current(where)) this.error = String(e)
          } finally {
            if (this.where === where) this.pending.delete(path)
            spawned.notify()
          }
        })
      }
    }
    cx.notify()
  }

  rows(prefix: string, depth: number, out: Element[], t: Theme): Element[] {
    if (out.length >= TOTAL || depth > 40) return out
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const open = this.folders.has(path)
      const mark = this.marks[`${this.where.cwd}/${path}`]
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
              ? this.toggle(path, cx)
              : this.setTabs(openFile(this.tabs, { path: `${this.where.cwd}/${path}`, on: this.where.on }), cx),
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
                .text_size(11)
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
    if (this.locate().key !== this.where.key) this.refresh(cx)
    const t = themeColors()
    const empty = this.error || (this.loading ? "Loading files…" : this.where.cwd ? "No files" : "No folder")
    const tree = v_flex()
      .id("files-tree")
      .size_full()
      .overflow_y_scrollbar()
      .p(6)
      .children(this.rows("", 0, [], t))
      .when(Boolean(this.error) || !this.entries.get("")?.length, (el) =>
        el.child(div().p(8).text_size(12).text_color(t.dim).child(empty)),
      )
      .when(this.limited, (el) =>
        el.child(
          div()
            .p(8)
            .text_size(11)
            .text_color(t.dim)
            .child("File list limited to 500 entries per folder and 5,000 total"),
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
      .text_size(13)
      .child(this.header(t))
      .child(
        h_resizable("vibest-files-body")
          .flex_1()
          .min_h(0)
          .child(resizable_panel().child(this.content(cx, t)))
          .when(this.treeOpen, (el) => el.child(resizable_panel().size(220).size_range(140, 520).child(tree))),
      )
  }
}
