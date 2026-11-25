import { findNode, type LayoutNode } from "./layout-tree.ts"

export const CONTROL = 32
export const INSET = 8
export const EDGE = 4
export const CONTENT = 4
export const HEADER_X = 8
export const LIGHTS_X = 13
export const LIGHTS_INSET = 74
const LIGHTS_SIZE = 15
const BAR = 32
const PANE_HEADER = 24
const BARS = ["topbar", "sidebar-header"]
export const LEFT_GUTTER = "left-gutter"
export const MAIN = "main"
const CHAT = "chat"
const TABS = "terminals"

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

export const metrics = (layout: LayoutNode | null | undefined): Metrics => {
  const root = layout ?? undefined
  const pad = vertical(findNode(root, "workspace-body")?.padding)
  const border = findNode(root, "terminals")?.content?.pane?.border?.width ?? 0
  const bar = BAR
  const head = PANE_HEADER + 2 * CONTENT

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

export interface Chats {
  readonly shown: string | null
  readonly kept: readonly string[]
}

const chatId = (terminal: string): string => `${CHAT}-${terminal.replaceAll(/[^0-9a-z]/gi, "-")}`

export const mainChild = (chat: string | null): string => (chat ? chatId(chat) : TABS)

const chatBlocks = (main: LayoutNode, kept: readonly string[]): LayoutNode[] => {
  const children = main.children ?? []
  const template = children.find((c) => c.id === CHAT)

  if (!template) return [...children]

  return [
    ...children.filter((c) => !c.id?.startsWith(`${CHAT}-`)),
    ...kept.map((terminal) => ({ ...template, id: chatId(terminal), content: { terminal } })),
  ]
}

const resize = (node: LayoutNode, m: Metrics, sidebarHidden: boolean, chats: Chats): LayoutNode => {
  const pane = node.content?.pane
  const next: MutableLayoutNode = { ...node }

  if (node.id && BARS.includes(node.id)) {
    next.size = { ...node.size, px: m.bar }
  }

  if (pane?.header) {
    next.content = { ...node.content, pane: { ...pane, header: { ...pane.header, height: m.head - CONTENT } } }
  }

  if (node.id === LEFT_GUTTER) {
    next.hidden = !sidebarHidden
  }

  if (node.id === MAIN) {
    next.active = mainChild(chats.shown)
    next.children = chatBlocks(node, chats.kept)

    return next
  }

  if (node.children) {
    next.children = node.children.map((c) => resize(c, m, sidebarHidden, chats))
  }

  return next
}

export const fitLayout = (
  layout: LayoutNode | null | undefined,
  m: Metrics,
  chats: Chats = { shown: null, kept: [] },
): LayoutNode | null => {
  if (!layout?.children) return null

  const next = {
    ...resize(layout, m, Boolean(findNode(layout, "sidebar")?.hidden), chats),
    traffic_lights: m.lights,
    terminal_padding: [CONTENT, CONTENT],
  }

  return JSON.stringify(next) === JSON.stringify(layout) ? null : next
}
