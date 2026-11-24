import { type Activity, LOCAL, type VibestProject, type VibestSession, type VibestState } from "./vibest-model.ts"

const MIN = 60_000

const project = (
  id: string,
  machine: string,
  directory: string,
  activity: Activity,
  identities: readonly (string | null)[],
): VibestProject => ({
  id,
  machine,
  directory,
  activity,
  repositories: identities.map((identity, i) => ({
    path: identities.length > 1 ? `${directory}/r${i}` : directory,
    identity,
  })),
})

const session = (
  projectId: string,
  machine: string,
  name: string,
  status: string,
  ago: number,
  now: number,
  id = `${projectId}-${name.toLowerCase().replaceAll(" ", "-")}`,
): VibestSession => ({
  id,
  projectId,
  machine,
  parentId: name === "entry" ? null : `${projectId}-entry`,
  name,
  agent: name === "entry" ? "coordinator" : "general",
  harness: "claude",
  status,
  branch: name === "entry" ? "main" : `feat/${name.toLowerCase().replaceAll(" ", "-")}`,
  terminal: null,
  lastActive: now - ago * MIN,
})

export const mockState = (now: number): VibestState => ({
  note: "Mock data",
  machines: [
    { name: "mac-mini", state: "connected", reason: "" },
    { name: "devbox", state: "unreachable", reason: "devbox runs an older vibest; run vibest update there" },
  ],
  projects: [
    project("p-vibest", LOCAL, "/Users/me/code/vibest", "working", ["github.com/acme/vibest"]),
    project("m-vibest", "mac-mini", "/Volumes/SSD/vibest", "idle", ["github.com/acme/vibest"]),
    project("p-fork", LOCAL, "/Users/me/forks/vibest", "idle", ["github.com/me/vibest"]),
    project("p-shop", LOCAL, "/Users/me/work/shop", "blocked", [
      "git.example.com/shop/web",
      "git.example.com/shop/api",
    ]),
    project("p-notes", LOCAL, "/Users/me/notes", "idle", [null]),
  ],
  sessions: [
    session("p-vibest", LOCAL, "entry", "working", 1, now, "p-vibest-entry"),
    session("p-vibest", LOCAL, "Fix slow session list", "working", 3, now),
    session("p-vibest", LOCAL, "Review web hub PR", "done", 12, now),
    session("m-vibest", "mac-mini", "entry", "idle", 40, now, "m-vibest-entry"),
    session("m-vibest", "mac-mini", "Loopback WebSocket for Watch", "working", 2, now),
    session("p-fork", LOCAL, "entry", "idle", 300, now, "p-fork-entry"),
    session("p-shop", LOCAL, "entry", "idle", 30, now, "p-shop-entry"),
    session("p-shop", LOCAL, "Checkout page copy", "blocked", 5, now),
    session("p-notes", LOCAL, "entry", "idle", 600, now, "p-notes-entry"),
  ],
})
