export type NavTab = "board" | "artifacts" | "sessions" | "knowledge"

export interface WorkspaceHashRoute {
  readonly projectId: string | undefined
  readonly tab: NavTab
  readonly artifactId: string | null
}

function parseNavTab(raw: string | null): NavTab {
  switch (raw) {
    case "board":
    case "artifacts":
    case "sessions":
    case "knowledge":
      return raw
    default:
      return "board"
  }
}

export function parseWorkspaceHash(rawHash: string): WorkspaceHashRoute {
  const trimmed = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash
  const params = new URLSearchParams(trimmed)
  const projectRaw = params.get("project")?.trim()
  const artifactRaw = params.get("artifact")?.trim()

  return {
    projectId: projectRaw && projectRaw.length > 0 ? projectRaw : undefined,
    tab: parseNavTab(params.get("tab")),
    artifactId: artifactRaw && artifactRaw.length > 0 ? artifactRaw : null,
  }
}

export function formatWorkspaceHash(projectId: string, tab: NavTab, artifactId: string | null): string {
  const params = new URLSearchParams()

  if (projectId.length > 0) {
    params.set("project", projectId)
  }

  params.set("tab", tab)

  if (artifactId && artifactId.length > 0) {
    params.set("artifact", artifactId)
  }

  return `#${params.toString()}`
}
