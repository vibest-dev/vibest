export interface LayoutNode {
  readonly id?: string
  readonly hidden?: boolean
  readonly active?: string
  readonly padding?: number | readonly number[]
  readonly size?: { readonly px?: number }
  readonly traffic_lights?: readonly number[]
  readonly content?: {
    readonly pane?: { readonly border?: { readonly width?: number }; readonly header?: { readonly height?: number } }
  }
  readonly children?: readonly LayoutNode[]
}

export const findNode = (node: LayoutNode | undefined, id: string): LayoutNode | undefined => {
  if (node?.id === id) return node
  for (const child of node?.children ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}
