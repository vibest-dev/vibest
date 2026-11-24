import { describe, expect, it } from "vitest"

import { agentTree, groupKey, mainSession, projectGroups } from "./project-groups.ts"
import { mockState } from "./vibest-mock.ts"
import { LOCAL, loudest, type VibestProject, type VibestSession } from "./vibest-model.ts"

const NOW = 1_800_000_000_000

const base: VibestProject = {
  id: "x",
  machine: LOCAL,
  directory: "/a/b",
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

  it("splits each member into its main conversation and its other sessions, newest first", () => {
    const local = groups.find((g) => g.key === "github.com/acme/vibest")?.members[0]

    expect(local?.main?.id).toBe("p-vibest-entry")
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

describe("mainSession", () => {
  const root = (id: string, lastActive: number, terminal: string | null): VibestSession => ({
    ...mockState(NOW).sessions[0]!,
    id,
    parentId: null,
    lastActive,
    terminal,
  })

  it("is the newest root conversation, preferring one with a terminal", () => {
    expect(mainSession([root("old", 1, "t1"), root("new", 2, null)])?.id).toBe("old")
    expect(mainSession([root("old", 1, "t1"), root("new", 2, "t2")])?.id).toBe("new")
    expect(mainSession([{ ...root("child", 3, "t3"), parentId: "old" }])).toBeNull()
  })
})

describe("agentTree", () => {
  const s = (id: string, parentId: string | null): VibestSession => ({ ...mockState(NOW).sessions[0]!, id, parentId })

  it("nests each session under its parent and lifts children of the main conversation to the top", () => {
    const rows = agentTree([s("a", "main"), s("b", null), s("a1", "a"), s("a11", "a1")])

    expect(rows.map((r) => [r.session.id, r.depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["a11", 2],
      ["b", 0],
    ])
  })
})
