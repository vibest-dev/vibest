interface Cx {
  notify(): void
  spawn(task: (cx: Cx) => Promise<void>): void
  stop_propagation(): void
  timer: { every(ms: number, task: (cx: Cx) => void): void }
}

interface Chain {
  id(value: string): Chain
  size(value: number): Chain
  size_full(): Chain
  flex(): Chain
  flex_1(): Chain
  flex_none(): Chain
  relative(): Chain
  absolute(): Chain
  top(value: number): Chain
  right(value: number): Chain
  w(value: number): Chain
  h(value: number): Chain
  min_w(value: number): Chain
  min_h(value: number): Chain
  max_w(value: number): Chain
  p(value: number): Chain
  px(value: number): Chain
  py(value: number): Chain
  pl(value: number): Chain
  pr(value: number): Chain
  pt(value: number): Chain
  pb(value: number): Chain
  mt(value: number): Chain
  gap(value: number): Chain
  items_center(): Chain
  justify_center(): Chain
  justify_end(): Chain
  bg(value: string): Chain
  border(value: number): Chain
  border_color(value: string): Chain
  rounded(value: number): Chain
  rounded_full(): Chain
  text_size(value: number): Chain
  text_color(value: string): Chain
  font_medium(): Chain
  font_semibold(): Chain
  font_weight(value: number): Chain
  truncate(): Chain
  overflow_y_scrollbar(): Chain
  cursor_pointer(): Chain
  tooltip(text: string): Chain
  loop(property: "opacity", motion: { from: number; to: number; period: number }): Chain
  child(value: unknown): Chain
  children(value: readonly unknown[]): Chain
  hover(style: (el: Chain) => Chain): Chain
  on_hover(handle: (hovered: boolean, cx: Cx) => void): Chain
  on_click(handle: (event: unknown, cx: Cx) => void): Chain
  on_mouse_down(button: "left" | "right", handle: (event: unknown, cx: Cx) => void): Chain
  when(cond: unknown, apply: (el: Chain) => Chain): Chain
}

declare const localStorage: {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

declare module "gpui-kit" {
  export abstract class View {
    init(props: unknown, cx: Cx): void
    close?(cx: Cx): void | Promise<void>
    abstract render(cx: Cx): unknown
  }
  export function div(): Chain
  export function svg(path: string): Chain
}

declare module "gpui-base" {
  export function v_flex(): Chain
  export function h_flex(): Chain
}

declare module "herdr" {
  export type Status = "working" | "blocked" | "done" | "idle"

  export type Theme = Record<
    | "background"
    | "chrome"
    | "surface"
    | "hover"
    | "selected"
    | "border"
    | "foreground"
    | "muted"
    | "dim"
    | "accent"
    | "unknown"
    | Status,
    string
  >

  export interface TabInfo {
    id: string
    index: number
    name: string
    named: boolean
    active: boolean
    status: Status | null
    zoomed: boolean
    settled: boolean
    changed_at: number | null
    working_since: number | null
  }

  export interface SpaceInfo {
    id: string
    name: string
    machine: string | null
    branch: string | null
    active: boolean
    status: Status | null
    tabs: TabInfo[]
  }

  export interface Program {
    key: string
    name: string
    agent: boolean
  }

  export interface PaneInfo {
    pane: string
    terminal: string | null
    tab: string
    title: string
    program?: Program
  }

  export interface LayoutNode {
    id?: string
    hidden?: boolean
    active?: string
    children?: LayoutNode[]
  }

  export function exec(
    command: string,
    args?: string[],
    options?: { cwd?: string; on?: string | null },
  ): Promise<{ code: number; stdout: string; stderr: string }>
  export function appHome(): string
  export function theme(): Theme
  export function spaces(): SpaceInfo[]
  export function panes(): PaneInfo[]
  export function focused(): { pane: string | null } | null
  export function layout(): unknown
  export function window(): { platform: "linux" | "macos" | "windows"; buttons: boolean; fullscreen: boolean } | null
  export function updates(): { app?: { ready: string | null } } | null
  export function run(name: string, args?: Record<string, unknown>): null
  export function openOverlay(spec: {
    mod: string
    kind: "dialog" | "popup" | "window"
    width?: number
    height?: number
    props?: Record<string, unknown>
  }): string
  export function pickFolder(options?: { prompt?: string }): Promise<string | null>
}
