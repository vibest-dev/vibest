export const LOCAL = "local"

export type Activity = "blocked" | "working" | "done" | "idle"

export interface Repository {
  readonly path: string
  readonly identity: string | null
}

export interface VibestProject {
  readonly id: string
  readonly machine: string
  readonly directory: string
  readonly activity: Activity
  readonly repositories: readonly Repository[]
}

export interface VibestSession {
  readonly id: string
  readonly projectId: string
  readonly machine: string
  readonly parentId: string | null
  readonly name: string
  readonly agent: string
  readonly harness: string
  readonly status: string
  readonly branch: string
  readonly terminal: string | null
  readonly lastActive: number | null
}

export interface VibestMachine {
  readonly name: string
  readonly state: string
  readonly reason: string
}

export interface VibestState {
  readonly projects: readonly VibestProject[]
  readonly sessions: readonly VibestSession[]
  readonly machines: readonly VibestMachine[]
  readonly note: string
}

const activityOf = (status: string): Activity | null => {
  switch (status) {
    case "blocked":
    case "working":
    case "done":
    case "idle":
      return status
    default:
      return null
  }
}

const RANK = { blocked: 4, working: 3, done: 2, idle: 1 } as const satisfies Record<Activity, number>

export const loudest = (statuses: readonly string[]): Activity => {
  let best: Activity = "idle"

  for (const status of statuses) {
    const activity = activityOf(status)

    if (activity !== null && RANK[activity] > RANK[best]) best = activity
  }

  return best
}

export const isBusy = (status: string): boolean => status === "working" || status === "blocked"
