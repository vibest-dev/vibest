import { describe, expect, it } from "vitest"

import { groupKey, projectGroups } from "./project-groups.ts"
import { mockState } from "./vibest-mock.ts"
import { LOCAL, loudest, type VibestProject } from "./vibest-model.ts"

const NOW = 1_800_000_000_000

const base: VibestProject = {
  id: "x",
  machine: LOCAL,
  directory: "/a/b",
  entrySessionId: null,
  activity: "idle",
  repositories: [],
}

describe("groupKey", () => {
  it("is the identity for one repository and the sorted identities for several", () => {
    expect(groupKey({ ...base, repositories: [{ path: "/a/b", identity: "github.com/o/r" }] })).toBe("github.com/o/r")
    expect(
      groupKey({
        ...base,
        repositories: [
          { path: "/a/b/2", identity: "h/z" },
          { path: "/a/b/1", identity: "h/a" },
        ],
      }),
    ).toBe("h/a+h/z")
  })

  it("falls back to machine and folder when a repository has no remote, or there is none", () => {
    expect(groupKey({ ...base, repositories: [{ path: "/a/b", identity: null }] })).toBe("local:/a/b")
    expect(groupKey({ ...base, machine: "mini" })).toBe("mini:/a/b")
  })
})

describe("projectGroups", () => {
  const groups = projectGroups(mockState(NOW))
  const byLabel = (label: string) => groups.find((g) => g.label === label && g.members[0]?.project.id !== "p-fork")

  it("merges one repository across machines, this machine first", () => {
    const vibest = groups.find((g) => g.key === "github.com/acme/vibest")

    expect(vibest?.members.map((m) => m.machine)).toEqual([LOCAL, "mac-mini"])
    expect(vibest?.label).toBe("acme/vibest")
    expect(vibest?.activity).toBe("working")
  })

  it("keeps a fork apart from its upstream, and names both by owner when their names clash", () => {
    const fork = groups.find((g) => g.key === "github.com/me/vibest")

    expect(fork?.members).toHaveLength(1)
    expect(fork?.label).toBe("me/vibest")
  })

  it("names a multi-repository project after its folder and a remote-less one after its folder", () => {
    expect(byLabel("shop")?.key).toBe("git.example.com/shop/api+git.example.com/shop/web")
    expect(byLabel("notes")?.key).toBe("local:/Users/me/notes")
  })

  it("splits each member into its entry and its other sessions, newest first", () => {
    const local = groups.find((g) => g.key === "github.com/acme/vibest")?.members[0]

    expect(local?.entry?.id).toBe("p-vibest-entry")
    expect(local?.sessions.map((s) => s.name)).toEqual(["Fix slow session list", "Review web hub PR"])
  })

  it("lifts a blocked session over the project's own activity", () => {
    expect(byLabel("shop")?.activity).toBe("blocked")
  })
})

describe("loudest", () => {
  it("ranks blocked, working, done, idle and ignores unknown", () => {
    expect(loudest(["idle", "done", "unknown"])).toBe("done")
    expect(loudest(["working", "blocked"])).toBe("blocked")
    expect(loudest([])).toBe("idle")
  })
})
