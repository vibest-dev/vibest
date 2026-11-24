import { describe, expect, it } from "vitest"

import { LOCAL } from "./vibest-model.ts"
import { applyFrame, emptyState, type WatchFrame } from "./watch-state.ts"

const wire = (text: string): WatchFrame => JSON.parse(text)

const PROJECT = `{"id":"p1","directory":"/r","entrySessionId":"s1","activity":"working","repositories":[]}`

const SESSION = (status: string) =>
  `{"id":"s1","name":"entry","agent":"general","harness":"pi","status":"${status}","projectId":"p1",` +
  `"address":{"machine":"local","id":"t1r"},"git":{"branch":"main"},"lastActive":5,"parentId":null}`

describe("applyFrame", () => {
  const snap = applyFrame(
    emptyState("Connecting…"),
    wire(`{"result":[{"_tag":"Snapshot","projects":[${PROJECT}],"sessions":[${SESSION("working")}],"machines":[]}]}`),
  )

  it("replaces the state with a snapshot and clears the note", () => {
    expect(snap.note).toBe("")
    expect(snap.projects[0]).toMatchObject({ id: "p1", machine: LOCAL, directory: "/r" })
    expect(snap.sessions[0]).toMatchObject({ terminal: "t1r", branch: "main", machine: LOCAL })
  })

  it("upserts sessions and drops ended ones by id and machine", () => {
    const blocked = applyFrame(snap, wire(`{"result":[{"_tag":"Session","session":${SESSION("blocked")}}]}`))

    expect(blocked.sessions.map((s) => s.status)).toEqual(["blocked"])

    const ended = applyFrame(blocked, wire(`{"result":[{"_tag":"SessionEnded","id":"s1","projectId":"p1"}]}`))

    expect(ended.sessions).toEqual([])
  })

  it("keeps a project in place when it updates", () => {
    const two = applyFrame(snap, wire(`{"result":[{"_tag":"Project","project":${PROJECT.replace("p1", "p2")}}]}`))

    const updated = applyFrame(
      two,
      wire(`{"result":[{"_tag":"Project","project":${PROJECT.replace("working", "done")}}]}`),
    )

    expect(updated.projects.map((p) => [p.id, p.activity])).toEqual([
      ["p1", "done"],
      ["p2", "working"],
    ])
  })

  it("tracks machines and reports errors in the note", () => {
    const up = applyFrame(snap, wire(`{"result":[{"_tag":"Machine","machine":{"name":"mini","state":"connected"}}]}`))

    expect(up.machines).toEqual([{ name: "mini", state: "connected", reason: "" }])
    expect(applyFrame(up, wire(`{"result":[{"_tag":"MachineRemoved","name":"mini"}]}`)).machines).toEqual([])
    expect(applyFrame(up, wire(`{"error":{"_tag":"Forbidden"}}`)).note).toContain("Forbidden")
  })
})
