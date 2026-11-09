import type { PaneInfo } from "herdr"

export const paneName = (p: PaneInfo): string =>
  ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell"

export const shortFolder = (cwd: string | null, home: string): string => {
  if (!cwd) return ""
  if (cwd === home) return "~"
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
}
