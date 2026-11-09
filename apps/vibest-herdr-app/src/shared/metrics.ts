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
  typeof padding === "number" ? padding : (padding?.[0] ?? 0)

const center = (band: number, size: number): number => Math.floor((band - size) / 2)

export const metrics = (layout: unknown, viewportHeight: number, fontSize: number): Metrics => {
  const root = layout as LayoutNode
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

const resize = (node: LayoutNode, m: Metrics): LayoutNode => {
  const pane = node.content?.pane
  return {
    ...node,
    ...(BARS.includes(node.id) ? { size: { ...node.size, px: m.bar } } : {}),
    ...(pane?.header
      ? { content: { ...node.content, pane: { ...pane, header: { ...pane.header, height: m.head - INSET } } } }
      : {}),
    ...(node.children ? { children: node.children.map((c) => resize(c, m)) } : {}),
  }
}

export const fitLayout = (layout: unknown, m: Metrics): LayoutNode | null => {
  const root = layout as LayoutNode
  if (!root?.children) return null
  const next = {
    ...resize(root, m),
    traffic_lights: m.lights,
    terminal_padding: [root.terminal_padding?.[0] ?? 0, INSET],
  }
  return JSON.stringify(next) === JSON.stringify(root) ? null : next
}
