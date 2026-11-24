import { findNode, type LayoutNode } from "./layout-tree.ts"

export const TEXT = 14
export const SMALL = 12
export const CONTROL = 32
export const INSET = 8
export const LIGHTS_X = 13
export const LIGHTS_INSET = 65
const LIGHTS_SIZE = 15
const BAR_MIN = 30
const HEAD_MIN = 36
const BARS = ["topbar", "sidebar-header"]

export interface Metrics {
  readonly bar: number
  readonly pad: number
  readonly head: number
  readonly searchTop: number
  readonly lights: readonly [number, number]
}

const vertical = (padding: LayoutNode["padding"]): number =>
  Array.isArray(padding) ? (padding[0] ?? 0) : Number(padding ?? 0)

const center = (band: number, size: number): number => Math.floor((band - size) / 2)

export const metrics = (layout: LayoutNode | null | undefined, viewportHeight: number, fontSize: number): Metrics => {
  const root = layout ?? undefined
  const pad = vertical(findNode(root, "workspace-body")?.padding)
  const border = findNode(root, "terminals")?.content?.pane?.border?.width ?? 0
  const row = Math.round(fontSize * 1.5)
  const fixed = BAR_MIN + pad + border + HEAD_MIN + INSET + border + pad
  const leftover = (((Math.floor(viewportHeight) - fixed) % row) + row) % row
  const third = Math.floor(leftover / 3)
  const bar = BAR_MIN + third
  const head = HEAD_MIN + leftover - third

  return {
    bar,
    pad,
    head,
    searchTop: pad + border + center(head, CONTROL),
    lights: [LIGHTS_X, center(bar + pad, LIGHTS_SIZE)],
  }
}

interface MutableLayoutNode {
  id?: string
  hidden?: boolean
  active?: string
  padding?: number | readonly number[]
  size?: { readonly px?: number }
  traffic_lights?: readonly number[]
  terminal_padding?: readonly number[]
  content?: LayoutNode["content"]
  children?: readonly LayoutNode[]
}

const resize = (node: LayoutNode, m: Metrics): LayoutNode => {
  const pane = node.content?.pane
  const next: MutableLayoutNode = { ...node }

  if (node.id && BARS.includes(node.id)) {
    next.size = { ...node.size, px: m.bar }
  }

  if (pane?.header) {
    next.content = { ...node.content, pane: { ...pane, header: { ...pane.header, height: m.head - INSET } } }
  }

  if (node.children) {
    next.children = node.children.map((c) => resize(c, m))
  }

  return next
}

export const fitLayout = (layout: LayoutNode | null | undefined, m: Metrics): LayoutNode | null => {
  if (!layout?.children) return null

  const next = {
    ...resize(layout, m),
    traffic_lights: m.lights,
    terminal_padding: [layout.terminal_padding?.[0] ?? 0, INSET],
  }

  return JSON.stringify(next) === JSON.stringify(layout) ? null : next
}
