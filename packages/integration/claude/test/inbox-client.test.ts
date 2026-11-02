// Unwired Claude inbox client. Fake IO and controlled promises only: no sleeps, processes, or native APIs.
import { assert, describe, it } from "@effect/vitest"

import {
  createClaudeInboxClient,
  type AttachReply,
  type ClaudeInboxClient,
  type InboxIo,
  type InboxSnapshot,
  type Phase,
  type PullReply,
  type SettleReply,
  type SubmitReply,
} from "../src/inbox-client.ts"

const gate = <T>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const reached = async (ready: () => boolean) => {
  for (let i = 0; i < 50 && !ready(); i++) await Promise.resolve()
  if (!ready()) throw new Error("expected state was not reached on the microtask queue")
}

type Call = { generation: string; sessionId: string; token: string }
type ReleaseCall = Call & { retry: boolean }
type SubmitSeen = { text: string; phase: Phase; token: string | undefined; generation: string | undefined }

const harness = (attach: () => Promise<AttachReply> = async () => ({ kind: "attached", generation: "g1" })) => {
  const ref: { client?: ClaudeInboxClient } = {}
  const look = (): InboxSnapshot => {
    const client = ref.client
    if (client === undefined) throw new Error("client not ready")
    return client.snapshot()
  }
  const attachArgs: unknown[][] = []
  const pulls: unknown[][] = []
  const reads: string[] = []
  const readPhases: Phase[] = []
  const submits: SubmitSeen[] = []
  const acks: Call[] = []
  const releases: ReleaseCall[] = []
  let session = "s1"
  const pull = { current: async (): Promise<PullReply> => ({ kind: "claim", token: "t1", file: "f1" }) }
  const read = { current: async (): Promise<string> => "body" }
  const submit = { current: async (): Promise<SubmitReply> => ({ kind: "accepted", text: "queued" }) }
  const ack = { current: async (): Promise<SettleReply> => ({ kind: "ok" }) }
  const release = { current: async (): Promise<SettleReply> => ({ kind: "ok" }) }
  const io: InboxIo = {
    sessionId: () => session,
    attach: async (...args: unknown[]) => {
      attachArgs.push(args)
      return attach()
    },
    pull: async (...args: unknown[]) => {
      pulls.push(args)
      return pull.current()
    },
    readClaim: async (file) => {
      reads.push(file)
      readPhases.push(look().phase)
      return read.current()
    },
    submit: async (text) => {
      const seen = look()
      submits.push({ text, phase: seen.phase, token: seen.token, generation: seen.generation })
      return submit.current()
    },
    ack: async (generation, sessionId, token) => {
      acks.push({ generation, sessionId, token })
      return ack.current()
    },
    release: async (generation, sessionId, token, retry) => {
      releases.push({ generation, sessionId, token, retry })
      return release.current()
    },
  }
  const client = createClaudeInboxClient(io)
  ref.client = client
  return {
    client,
    attachArgs,
    pulls,
    reads,
    readPhases,
    submits,
    acks,
    releases,
    pull,
    read,
    submit,
    ack,
    release,
    setSession: (id: string) => {
      session = id
    },
  }
}

const idle = async () => {
  const box = harness()
  assert.deepStrictEqual(await box.client.start(), {
    phase: "idle",
    generation: "g1",
    token: undefined,
    busy: false,
    stopReason: undefined,
    deliveryAccepted: false,
  })
  assert.deepStrictEqual(box.attachArgs, [["s1"]])
  return box
}

describe("Claude inbox client prototype", () => {
  it("accepts one prompt and acks that delivery once", async () => {
    const box = await idle()
    const done = await box.client.tick()
    assert.deepStrictEqual(box.readPhases, ["holding"])
    assert.deepStrictEqual(box.reads, ["f1"])
    assert.deepStrictEqual(box.submits, [{ text: "body", phase: "submitted", token: "t1", generation: "g1" }])
    assert.deepStrictEqual(box.acks, [{ generation: "g1", sessionId: "s1", token: "t1" }])
    assert.deepStrictEqual(box.releases, [])
    assert.deepStrictEqual(box.pulls, [["g1", "s1"]])
    assert.deepStrictEqual(done, {
      phase: "done",
      generation: "g1",
      token: undefined,
      busy: false,
      stopReason: undefined,
      deliveryAccepted: true,
    })
    assert.isUndefined(Object.getOwnPropertyDescriptor(done, "taskCompleted"))
  })

  it("releases with retry on a definite drop", async () => {
    const box = await idle()
    box.submit.current = async () => ({ kind: "drop" })
    const done = await box.client.tick()
    assert.deepStrictEqual(box.releases, [{ generation: "g1", sessionId: "s1", token: "t1", retry: true }])
    assert.deepStrictEqual(box.acks, [])
    assert.strictEqual(box.submits.length, 1)
    assert.isFalse(done.deliveryAccepted)
    assert.strictEqual(done.phase, "done")
  })

  it("releases without retry on an ambiguous submit failure and does not submit that token again", async () => {
    const failures: Array<() => Promise<SubmitReply>> = [
      async () => ({ kind: "ambiguous" }),
      async () => {
        throw new Error("rejected")
      },
    ]
    for (const current of failures) {
      const box = await idle()
      box.submit.current = current
      let tries = 0
      box.release.current = async () => {
        tries += 1
        return tries === 1 ? { kind: "lost" } : { kind: "ok" }
      }
      const pending = await box.client.tick()
      assert.strictEqual(pending.phase, "settle-release-fail")
      assert.strictEqual(pending.token, "t1")
      assert.deepStrictEqual(box.releases, [{ generation: "g1", sessionId: "s1", token: "t1", retry: false }])
      assert.deepStrictEqual(box.acks, [])
      const settled = await box.client.tick()
      assert.strictEqual(settled.phase, "done")
      assert.strictEqual(box.submits.length, 1)
      assert.strictEqual(box.releases.length, 2)
      assert.strictEqual(box.pulls.length, 1)
      assert.isFalse(box.releases[1]?.retry)
    }
  })

  it("releases without retry when the claim cannot be read and does not submit", async () => {
    const box = await idle()
    box.read.current = async () => {
      throw new Error("unreadable")
    }
    const done = await box.client.tick()
    assert.deepStrictEqual(box.readPhases, ["holding"])
    assert.deepStrictEqual(box.submits, [])
    assert.deepStrictEqual(box.acks, [])
    assert.deepStrictEqual(box.releases, [{ generation: "g1", sessionId: "s1", token: "t1", retry: false }])
    assert.strictEqual(done.phase, "done")
    assert.isFalse(done.deliveryAccepted)
  })

  it("releases an empty claim without retry and submits a nonempty payload unchanged", async () => {
    const empty = await idle()
    empty.read.current = async () => ""
    const released = await empty.client.tick()
    assert.deepStrictEqual(empty.submits, [])
    assert.deepStrictEqual(empty.acks, [])
    assert.deepStrictEqual(empty.releases, [{ generation: "g1", sessionId: "s1", token: "t1", retry: false }])
    assert.strictEqual(released.phase, "done")
    assert.isFalse(released.deliveryAccepted)

    const spaced = await idle()
    spaced.read.current = async () => "  x  "
    await spaced.client.tick()
    assert.deepStrictEqual(spaced.submits, [{ text: "  x  ", phase: "submitted", token: "t1", generation: "g1" }])
    assert.strictEqual(spaced.acks.length, 1)
  })

  it("does not submit a lost, unparsed, or empty pull", async () => {
    const replies: Array<() => Promise<PullReply>> = [
      async () => {
        throw new Error("lost")
      },
      async () => ({ kind: "lost" }),
      async () => ({ kind: "unparsed" }),
      async () => ({ kind: "none" }),
    ]
    for (const current of replies) {
      const box = await idle()
      box.pull.current = current
      const snap = await box.client.tick()
      assert.strictEqual(snap.phase, "idle")
      assert.isUndefined(snap.token)
      assert.isFalse(snap.busy)
      assert.deepStrictEqual(box.submits, [])
      assert.deepStrictEqual(box.reads, [])
      assert.deepStrictEqual(box.acks, [])
    }
  })

  it("retries a lost ack that never committed, and does not submit again", async () => {
    const box = await idle()
    let committed = 0
    box.ack.current = async () => {
      if (box.acks.length === 1) return { kind: "lost" }
      committed += 1
      return { kind: "ok" }
    }
    const pending = await box.client.tick()
    assert.strictEqual(pending.phase, "settle-ack")
    assert.strictEqual(pending.token, "t1")
    assert.isTrue(pending.deliveryAccepted)
    assert.strictEqual(committed, 0)
    const done = await box.client.tick()
    assert.strictEqual(done.phase, "done")
    assert.strictEqual(committed, 1)
    assert.strictEqual(box.submits.length, 1)
    assert.deepStrictEqual(box.acks, [
      { generation: "g1", sessionId: "s1", token: "t1" },
      { generation: "g1", sessionId: "s1", token: "t1" },
    ])
    assert.deepStrictEqual(box.releases, [])
    assert.strictEqual(box.pulls.length, 1)
  })

  it("retries a lost ack that already committed, without writing or submitting again", async () => {
    const box = await idle()
    let writes = 0
    box.ack.current = async () => {
      if (writes === 0) {
        writes += 1
        return { kind: "lost" }
      }
      return { kind: "already" }
    }
    assert.strictEqual((await box.client.tick()).phase, "settle-ack")
    const done = await box.client.tick()
    assert.strictEqual(done.phase, "done")
    assert.strictEqual(writes, 1)
    assert.strictEqual(box.submits.length, 1)
    assert.strictEqual(box.acks.length, 2)
    assert.deepStrictEqual(box.releases, [])
    assert.strictEqual(box.pulls.length, 1)
  })

  it("retries a lost release and does not submit that token again", async () => {
    const box = await idle()
    box.submit.current = async () => {
      throw new Error("rejected")
    }
    box.release.current = async () => {
      if (box.releases.length === 1) throw new Error("lost")
      return { kind: "ok" }
    }
    assert.strictEqual((await box.client.tick()).phase, "settle-release-fail")
    const done = await box.client.tick()
    assert.strictEqual(done.phase, "done")
    assert.strictEqual(box.submits.length, 1)
    assert.strictEqual(box.releases.length, 2)
    assert.isFalse(box.releases[0]?.retry)
    assert.isFalse(box.releases[1]?.retry)
    assert.deepStrictEqual(box.acks, [])
    assert.strictEqual(box.pulls.length, 1)
  })

  it("repeats one settlement until it lands, then pulls a different token", async () => {
    const box = await idle()
    box.ack.current = async () => (box.acks.length < 3 ? { kind: "unparsed" } : { kind: "already" })
    assert.strictEqual((await box.client.tick()).phase, "settle-ack")
    assert.strictEqual((await box.client.tick()).token, "t1")
    const landed = await box.client.tick()
    assert.strictEqual(landed.phase, "done")
    assert.strictEqual(box.submits.length, 1)
    assert.strictEqual(box.acks.length, 3)
    box.pull.current = async () => ({ kind: "claim", token: "t2", file: "f2" })
    const next = await box.client.tick()
    assert.strictEqual(next.phase, "done")
    assert.strictEqual(next.generation, "g1")
    assert.deepStrictEqual(
      box.submits.map((item) => item.token),
      ["t1", "t2"],
    )
    assert.strictEqual(box.acks.length, 4)
    assert.deepStrictEqual(box.acks[3], { generation: "g1", sessionId: "s1", token: "t2" })
    assert.strictEqual(box.submits.filter((item) => item.token === "t1").length, 1)
  })

  it("an overlapping tick does not pull or submit", async () => {
    const box = await idle()
    const pending = gate<SubmitReply>()
    box.submit.current = () => pending.promise
    const first = box.client.tick()
    await reached(() => box.submits.length === 1)
    let finished = false
    const second = box.client.tick().then((snap) => {
      finished = true
      return snap
    })
    await reached(() => finished)
    const mid = await second
    assert.isTrue(mid.busy)
    assert.strictEqual(mid.phase, "submitted")
    assert.strictEqual(mid.token, "t1")
    assert.strictEqual(box.pulls.length, 1)
    assert.strictEqual(box.submits.length, 1)
    pending.resolve({ kind: "accepted", text: "queued" })
    assert.strictEqual((await first).phase, "done")
    assert.strictEqual(box.submits.length, 1)
    assert.strictEqual(box.acks.length, 1)
  })

  it("an old submit completing after reattach does not change the new claim", async () => {
    const box = await idle()
    const oldSubmit = gate<SubmitReply>()
    const newSubmit = gate<SubmitReply>()
    let active = oldSubmit
    box.submit.current = () => active.promise
    const first = box.client.tick()
    await reached(() => box.submits.length === 1)
    assert.strictEqual(box.submits[0]?.phase, "submitted")
    assert.deepStrictEqual(box.client.reattach("g2"), {
      phase: "idle",
      generation: "g2",
      token: undefined,
      busy: false,
      stopReason: undefined,
      deliveryAccepted: false,
    })
    assert.strictEqual(box.attachArgs.length, 1)
    active = newSubmit
    box.pull.current = async () => ({ kind: "claim", token: "t2", file: "f2" })
    const second = box.client.tick()
    await reached(() => box.submits.length === 2)
    const mid = box.client.snapshot()
    assert.deepStrictEqual(mid, {
      phase: "submitted",
      generation: "g2",
      token: "t2",
      busy: true,
      stopReason: undefined,
      deliveryAccepted: false,
    })
    oldSubmit.resolve({ kind: "accepted", text: "stale" })
    await first
    assert.deepStrictEqual(box.client.snapshot(), mid)
    assert.deepStrictEqual(box.acks, [])
    assert.deepStrictEqual(box.releases, [])
    assert.strictEqual(box.submits.filter((item) => item.token === "t1").length, 1)
    newSubmit.resolve({ kind: "accepted", text: "fresh" })
    const done = await second
    assert.deepStrictEqual(done, {
      phase: "done",
      generation: "g2",
      token: undefined,
      busy: false,
      stopReason: undefined,
      deliveryAccepted: true,
    })
    assert.deepStrictEqual(box.acks, [{ generation: "g2", sessionId: "s1", token: "t2" }])
    assert.strictEqual(box.submits.filter((item) => item.generation === "g1").length, 1)
  })

  it("reattach of the current generation does not submit the live token again", async () => {
    const box = await idle()
    const pending = gate<SubmitReply>()
    box.submit.current = () => pending.promise
    const first = box.client.tick()
    await reached(() => box.submits.length === 1)
    const before = box.client.snapshot()
    assert.deepStrictEqual(box.client.reattach("g1"), before)
    box.pull.current = async () => ({ kind: "claim", token: "t1", file: "f1" })
    box.submit.current = async () => ({ kind: "accepted", text: "again" })
    assert.deepStrictEqual(await box.client.tick(), before)
    assert.strictEqual(box.pulls.length, 1)
    assert.strictEqual(box.submits.length, 1)
    pending.resolve({ kind: "accepted", text: "queued" })
    assert.strictEqual((await first).phase, "done")
    assert.strictEqual(box.submits.length, 1)
    assert.deepStrictEqual(box.acks, [{ generation: "g1", sessionId: "s1", token: "t1" }])
    assert.deepStrictEqual(box.releases, [])
  })

  it("stops a new instance when the server already has an attachment, until reattach", async () => {
    const running = await idle()
    const pending = gate<SubmitReply>()
    running.submit.current = () => pending.promise
    const inflight = running.client.tick()
    await reached(() => running.submits.length === 1)

    const fresh = harness(async () => ({ kind: "stale-receiver" }))
    const stopped = await fresh.client.start()
    assert.strictEqual(stopped.phase, "stopped")
    assert.strictEqual(stopped.stopReason, "stale-receiver")
    assert.isUndefined(stopped.generation)
    await fresh.client.tick()
    await fresh.client.start()
    assert.deepStrictEqual(fresh.attachArgs, [["s1"]])
    assert.deepStrictEqual(fresh.pulls, [])
    assert.deepStrictEqual(fresh.submits, [])
    assert.deepStrictEqual(fresh.releases, [])
    assert.deepStrictEqual(fresh.acks, [])

    fresh.setSession("s2")
    assert.strictEqual(fresh.client.reattach("g9").generation, "g9")
    fresh.pull.current = async () => ({ kind: "none" })
    const idleSnap = await fresh.client.tick()
    assert.strictEqual(idleSnap.phase, "idle")
    assert.deepStrictEqual(fresh.pulls, [["g9", "s2"]])
    assert.strictEqual(fresh.attachArgs.length, 1)

    pending.resolve({ kind: "drop" })
    await inflight
    assert.deepStrictEqual(running.releases, [{ generation: "g1", sessionId: "s1", token: "t1", retry: true }])
    assert.deepStrictEqual(fresh.releases, [])
  })

  it("stops on a session mismatch or a stale receiver and does not switch settlement", async () => {
    const mismatched = await idle()
    mismatched.setSession("s2")
    const stopped = await mismatched.client.tick()
    assert.strictEqual(stopped.phase, "stopped")
    assert.strictEqual(stopped.stopReason, "session-mismatch")
    await mismatched.client.tick()
    assert.deepStrictEqual(mismatched.pulls, [])

    const duringSubmit = await idle()
    const pending = gate<SubmitReply>()
    duringSubmit.submit.current = async () => {
      duringSubmit.setSession("s2")
      return pending.promise
    }
    const inflight = duringSubmit.client.tick()
    await reached(() => duringSubmit.submits.length === 1)
    pending.resolve({ kind: "accepted", text: "queued" })
    const after = await inflight
    assert.strictEqual(after.phase, "stopped")
    assert.strictEqual(after.stopReason, "session-mismatch")
    assert.isFalse(after.deliveryAccepted)
    assert.deepStrictEqual(duringSubmit.acks, [])
    assert.deepStrictEqual(duringSubmit.releases, [])

    const duringRead = await idle()
    duringRead.read.current = async () => {
      duringRead.setSession("s2")
      throw new Error("unreadable")
    }
    const unread = await duringRead.client.tick()
    assert.strictEqual(unread.stopReason, "session-mismatch")
    assert.deepStrictEqual(duringRead.submits, [])
    assert.deepStrictEqual(duringRead.releases, [])

    const stalePull = await idle()
    stalePull.pull.current = async () => ({ kind: "stale-receiver" })
    assert.strictEqual((await stalePull.client.tick()).stopReason, "stale-receiver")
    assert.deepStrictEqual(stalePull.submits, [])

    const staleAck = await idle()
    staleAck.ack.current = async () => ({ kind: "stale-receiver" })
    assert.strictEqual((await staleAck.client.tick()).phase, "stopped")
    await staleAck.client.tick()
    assert.strictEqual(staleAck.submits.length, 1)
    assert.strictEqual(staleAck.acks.length, 1)
    assert.deepStrictEqual(staleAck.releases, [])
  })

  it("a not-reported attach stays new: the next start attaches again, and a reattach meanwhile wins", async () => {
    const answers: AttachReply[] = [{ kind: "not-reported" }, { kind: "attached", generation: "g1" }]
    const box = harness(async () => answers.shift()!)
    const waiting = await box.client.start()
    assert.strictEqual(waiting.phase, "new")
    assert.isUndefined(waiting.stopReason)
    await box.client.tick()
    assert.deepStrictEqual(box.pulls, [], "no pull before attach")
    assert.strictEqual((await box.client.start()).phase, "idle")
    assert.deepStrictEqual(box.attachArgs, [["s1"], ["s1"]])
    await box.client.tick()
    assert.deepStrictEqual(box.pulls, [["g1", "s1"]])

    const pending = gate<AttachReply>()
    const racing = harness(() => pending.promise)
    const starting = racing.client.start()
    await reached(() => racing.attachArgs.length === 1)
    racing.client.reattach("g2")
    pending.resolve({ kind: "not-reported" })
    await starting
    assert.strictEqual(racing.client.snapshot().phase, "idle")
    await racing.client.start()
    assert.strictEqual(racing.attachArgs.length, 1, "a late not-reported does not reopen startup attach")
  })

  it("a lost or unparsed attach does not poll and does not attach again", async () => {
    const replies: Array<() => Promise<AttachReply>> = [
      async () => ({ kind: "unparsed" }),
      async () => ({ kind: "lost" }),
      async () => {
        throw new Error("lost")
      },
    ]
    for (const attach of replies) {
      const box = harness(attach)
      const snap = await box.client.start()
      assert.strictEqual(snap.phase, "stopped")
      assert.strictEqual(snap.stopReason, "attach-failed")
      await box.client.tick()
      await box.client.start()
      assert.strictEqual(box.attachArgs.length, 1)
      assert.deepStrictEqual(box.attachArgs[0], ["s1"])
      assert.deepStrictEqual(box.pulls, [])
    }

    const pending = gate<AttachReply>()
    const racing = harness(() => pending.promise)
    const starting = racing.client.start()
    await reached(() => racing.attachArgs.length === 1)
    racing.client.reattach("g2")
    pending.resolve({ kind: "attached", generation: "g-old" })
    await starting
    assert.strictEqual(racing.client.snapshot().generation, "g2")
    assert.strictEqual(racing.client.snapshot().phase, "idle")
    assert.strictEqual(racing.attachArgs.length, 1)
  })
})
