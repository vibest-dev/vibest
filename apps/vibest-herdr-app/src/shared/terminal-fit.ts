export const BAR_HEIGHT = 32
export const FIXED_HEIGHT = BAR_HEIGHT + 8 * 2 + 2 + 40
export const LIGHTS = [13, 12] as const
export const BARS = ["topbar", "sidebar-header"] as const

interface Node {
  readonly id?: string
  readonly size?: { readonly px?: number }
  readonly traffic_lights?: readonly number[]
  readonly children?: readonly Node[]
}

export const rowHeight = (fontSize: number): number => Math.round(fontSize * 1.5)

export const barExtra = (viewportHeight: number, fontSize: number): number => {
  const row = rowHeight(fontSize)
  return (((Math.floor(viewportHeight) - FIXED_HEIGHT) % row) + row) % row
}

export const barShift = (extra: number): number => Math.floor(extra / 2)

const resize = (node: Node, px: number): Node => ({
  ...node,
  ...((BARS as readonly string[]).includes(node.id) ? { size: { ...node.size, px } } : {}),
  ...(node.children ? { children: node.children.map((c) => resize(c, px)) } : {}),
})

const sizes = (node: Node): number[] => [
  ...((BARS as readonly string[]).includes(node.id) ? [node.size?.px] : []),
  ...(node.children ?? []).flatMap(sizes),
]

export const fitLayout = (layout: unknown, extra: number): Node | null => {
  const root = layout as Node
  if (!root?.children) return null
  const px = BAR_HEIGHT + extra
  const lights = [LIGHTS[0], LIGHTS[1] + barShift(extra)]
  const fitted =
    sizes(root).every((s) => s === px) &&
    root.traffic_lights?.[0] === lights[0] &&
    root.traffic_lights?.[1] === lights[1]
  return fitted ? null : { ...resize(root, px), traffic_lights: lights }
}
