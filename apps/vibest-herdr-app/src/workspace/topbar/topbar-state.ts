import type { PaneInfo, SpaceInfo } from "herdr"

import { threadTitle } from "../../shared/thread-title.ts"

export const RIGHT_PANEL = "right-panel"

interface LayoutNode {
  readonly id?: string
  readonly hidden?: boolean
  readonly active?: string
  readonly children?: readonly LayoutNode[]
}

export interface Breadcrumb {
  readonly project: string
  readonly thread: string
  readonly branch: string | null
}

export interface TopbarState {
  readonly breadcrumb: Breadcrumb | null
  readonly shownPanel: string | null
  readonly sidebarHidden: boolean
}

const find = (node: LayoutNode | undefined, id: string): LayoutNode | undefined => {
  if (node?.id === id) return node
  for (const child of node?.children ?? []) {
    const found = find(child, id)
    if (found) return found
  }
  return undefined
}

export const topbarState = (layout: unknown, spaces: readonly SpaceInfo[], panes: readonly PaneInfo[]): TopbarState => {
  const root = layout as LayoutNode | undefined
  const panel = find(root, RIGHT_PANEL)
  const space = spaces.find((s) => s.active)
  const tab = space?.tabs.find((c) => c.active)
  return {
    breadcrumb: space
      ? {
          project: space.name,
          thread: tab
            ? threadTitle(
                tab,
                panes.filter((p) => p.tab === tab.id),
              )
            : "",
          branch: space.branch,
        }
      : null,
    shownPanel: panel && !panel.hidden ? (panel.active ?? null) : null,
    sidebarHidden: Boolean(find(root, "sidebar")?.hidden),
  }
}
