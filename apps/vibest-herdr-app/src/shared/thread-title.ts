import type { PaneInfo, TabInfo } from "herdr"

const leading = (s: string): string => s.replace(/^[^\p{L}\p{N}]+/u, "").trim()
const looksLikePath = (s: string): boolean => /^[~/]|^[A-Za-z]:\\/.test(s) || s.includes("@")

export const threadTitle = (tab: TabInfo, tabPanes: readonly PaneInfo[]): string => {
  if (tab.named) return tab.name
  const lead = tabPanes.find((p) => p.program?.agent) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0]
  const raw = (lead?.title ?? "").trim()
  const live = leading(raw)
  if (live && live !== lead?.terminal && !looksLikePath(raw) && live.toLowerCase() !== lead?.program?.key) return live
  return lead?.program?.agent ? lead.program.name : `Terminal ${tab.index}`
}
