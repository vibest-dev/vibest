import {
  type Activity,
  LOCAL,
  type VibestMachine,
  type VibestProject,
  type VibestSession,
  type VibestState,
} from "./vibest-model.ts"

interface WireRepository {
  readonly path: string
  readonly identity: string | null
}

interface WireProject {
  readonly id: string
  readonly directory: string | null
  readonly activity: Activity
  readonly repositories: readonly WireRepository[]
  readonly machine?: string
}

interface WireTerminal {
  readonly runtime: string
  readonly machine?: string
  readonly target: { readonly address?: string }
}

interface WireSession {
  readonly id: string
  readonly name: string
  readonly agent: string
  readonly harness: string
  readonly status: string
  readonly projectId: string
  readonly terminal: WireTerminal | null
  readonly git: { readonly branch: string } | null
  readonly lastActive: number
  readonly parentId: string | null
  readonly machine?: string
}

interface WireMachine {
  readonly name: string
  readonly state: string
  readonly reason?: string | null
}

export type WatchEvent =
  | {
      readonly _tag: "Snapshot"
      readonly projects: readonly WireProject[]
      readonly sessions: readonly WireSession[]
      readonly machines: readonly WireMachine[]
    }
  | { readonly _tag: "Project"; readonly project: WireProject }
  | { readonly _tag: "Session"; readonly session: WireSession }
  | { readonly _tag: "SessionEnded"; readonly id: string; readonly projectId: string; readonly machine?: string }
  | { readonly _tag: "Machine"; readonly machine: WireMachine }
  | { readonly _tag: "MachineRemoved"; readonly name: string }

export interface WatchFrame {
  readonly result?: readonly WatchEvent[]
  readonly error?: { readonly _tag?: string; readonly message?: string }
  readonly exit?: object
}

export const emptyState = (note: string): VibestState => ({ projects: [], sessions: [], machines: [], note })

const project = (p: WireProject): VibestProject => ({
  id: p.id,
  machine: p.machine ?? LOCAL,
  directory: p.directory ?? "",
  activity: p.activity,
  repositories: p.repositories,
})

const herdrAddress = (t: WireTerminal | null, sessionMachine: string | undefined): string | null => {
  const address = t?.runtime === "hc" ? t.target.address : undefined
  const machine = t?.machine ?? sessionMachine

  if (address === undefined) return null

  return machine === undefined || address.includes("/") ? address : `${machine}/${address}`
}

const branchOf = (git: WireSession["git"]): string =>
  (git?.branch ?? "")
    .split("\n")
    .map((line) => line.split("=").at(-1) ?? "")
    .filter((branch) => branch !== "")
    .join(", ")

const session = (s: WireSession): VibestSession => ({
  id: s.id,
  projectId: s.projectId,
  machine: s.machine ?? LOCAL,
  parentId: s.parentId,
  name: s.name,
  agent: s.agent,
  harness: s.harness,
  status: s.status,
  branch: branchOf(s.git),
  terminal: herdrAddress(s.terminal, s.machine),
  lastActive: s.lastActive,
})

const machine = (m: WireMachine): VibestMachine => ({ name: m.name, state: m.state, reason: m.reason ?? "" })

const same =
  (id: string, where: string) =>
  (item: { readonly id: string; readonly machine: string }): boolean =>
    item.id === id && item.machine === where

const upsert = <T extends { readonly id: string; readonly machine: string }>(list: readonly T[], next: T): T[] =>
  list.some(same(next.id, next.machine))
    ? list.map((item) => (same(next.id, next.machine)(item) ? next : item))
    : [...list, next]

export const applyEvent = (state: VibestState, event: WatchEvent): VibestState => {
  if ("projects" in event) {
    return {
      projects: event.projects.map(project),
      sessions: event.sessions.map(session),
      machines: event.machines.map(machine),
      note: "",
    }
  }

  if ("project" in event) return { ...state, projects: upsert(state.projects, project(event.project)) }

  if ("session" in event) return { ...state, sessions: upsert(state.sessions, session(event.session)) }

  if ("id" in event) {
    return { ...state, sessions: state.sessions.filter((s) => !same(event.id, event.machine ?? LOCAL)(s)) }
  }

  if ("machine" in event) {
    return {
      ...state,
      machines: [...state.machines.filter((m) => m.name !== event.machine.name), machine(event.machine)],
    }
  }

  return { ...state, machines: state.machines.filter((m) => m.name !== event.name) }
}

export const applyFrame = (state: VibestState, frame: WatchFrame): VibestState => {
  if (frame.error) return { ...state, note: `vibestd ended the watch (${frame.error._tag ?? "error"}), reconnecting…` }

  return (frame.result ?? []).reduce(applyEvent, state)
}
