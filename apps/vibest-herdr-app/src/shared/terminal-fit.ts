import { findNode, type LayoutNode } from "./layout-tree.ts"

const BAR_MIN = 32
const HEADER_MIN = 36
const SEARCH_ROW = 32
const LIGHTS_X = 13
const LIGHTS_SIZE = 15
const BARS = ["topbar", "sidebar-header"]

export interface Fit {
  readonly bar: number
  readonly header: number
  readonly pad: number
  readonly searchTop: number
  readonly lights: readonly [number, number]
}

const vertical = (padding: LayoutNode["padding"]): number =>
  typeof padding === "number" ? padding : (padding?.[0] ?? 0)

export const fit = (layout: unknown, viewportHeight: number, fontSize: number): Fit => {
  const root = layout as LayoutNode
  const pad = vertical(findNode(root, "workspace-body")?.padding)
  const border = findNode(root, "terminals")?.content?.pane?.border?.width ?? 0
  const row = Math.round(fontSize * 1.5)
  const leftover = (((Math.floor(viewportHeight) - BAR_MIN - 2 * pad - 2 * border - HEADER_MIN) % row) + row) % row
  const bar = BAR_MIN + Math.floor(leftover / 2)
  const header = HEADER_MIN + Math.ceil(leftover / 2)
  return {
    bar,
    header,
    pad,
    searchTop: pad + border + Math.floor((header - SEARCH_ROW) / 2),
    lights: [LIGHTS_X, Math.floor((bar + pad - LIGHTS_SIZE) / 2)],
  }
}

const resize = (node: LayoutNode, f: Fit): LayoutNode => {
  const pane = node.content?.pane
  return {
    ...node,
    ...(BARS.includes(node.id) ? { size: { ...node.size, px: f.bar } } : {}),
    ...(pane?.header
      ? { content: { ...node.content, pane: { ...pane, header: { ...pane.header, height: f.header } } } }
      : {}),
    ...(node.children ? { children: node.children.map((c) => resize(c, f)) } : {}),
  }
}

export const fitLayout = (layout: unknown, f: Fit): LayoutNode | null => {
  const root = layout as LayoutNode
  if (!root?.children) return null
  const next = { ...resize(root, f), traffic_lights: f.lights }
  return JSON.stringify(next) === JSON.stringify(root) ? null : next
}
