interface Cx {
  notify(): void
  spawn(task: (cx: Cx) => Promise<void>): void
  timer: { every(ms: number, task: (cx: Cx) => void): void }
}

interface Chain {
  id(value: string): Chain
  size_full(): Chain
  bg(value: string): Chain
  p(value: number): Chain
  px(value: number): Chain
  py(value: number): Chain
  gap(value: number): Chain
  text_size(value: number): Chain
  overflow_y_scrollbar(): Chain
  font_semibold(): Chain
  text_color(value: string): Chain
  truncate(): Chain
  flex_1(): Chain
  flex_none(): Chain
  w(value: number): Chain
  items_center(): Chain
  rounded(value: number): Chain
  cursor_pointer(): Chain
  child(value: unknown): Chain
  children(value: readonly unknown[]): Chain
  hover(style: (el: Chain) => Chain): Chain
  on_click(handle: (event: unknown, cx: Cx) => void): Chain
  when(cond: unknown, apply: (el: Chain) => Chain): Chain
}

declare module "gpui-kit" {
  export abstract class View {
    init(props: unknown, cx: Cx): void
    close?(cx: Cx): void | Promise<void>
    abstract render(cx: Cx): unknown
  }
  export function div(): Chain
}

declare module "gpui-base" {
  export function v_flex(): Chain
  export function h_flex(): Chain
}

declare module "herdr" {
  export function exec(
    command: string,
    args?: string[],
    options?: { cwd?: string; on?: string | null },
  ): Promise<{ code: number; stdout: string; stderr: string }>
  export function theme(): Record<string, string>
  export function panes(): unknown
  export function terminals(): unknown
  export function run(name: string, args?: Record<string, unknown>): null
  export function appHome(): string
}
