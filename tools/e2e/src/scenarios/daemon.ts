import net from "node:net"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask } from "../fake-model.ts"
import { alive, binary, expect, expectReplied, factsOf, until, type World } from "../world.ts"
import { piProject } from "./exits.ts"

type Status = { daemon: { status: string; pid?: number | null; protocol?: number | null } }

const status = (w: World) => w.json<Status>(["status"])
const running = async (w: World) => (await status(w)).daemon

const raw = (w: World, request: object) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.connect(path.join(w.vibestHome, "vibest.sock"))
    let buffer = ""
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split("\n")[0]
      if (buffer.includes("\n") && line) {
        socket.destroy()
        resolve(JSON.parse(line) as Record<string, unknown>)
      }
    })
    socket.on("error", reject)
    setTimeout(() => (socket.destroy(), reject(new Error("no reply in 5 s"))), 5_000)
  })

type Printed = { aggregate: string; seq: number; at: number; type: string; data: unknown }

const printed = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Printed)

const checks: ReadonlyArray<Check> = [
  {
    id: "D1",
    covers: ["D2", "D3", "D4"],
    title:
      "D1 status without a daemon reports not running and starts nothing; D2 daemon starts vibestd in the background; a second daemon starts no other; D3 a foreground vibestd while one runs does not take over: it says so and exits; the first keeps running; D4 daemon restart when idle replaces vibestd",
    run: async (w) => {
      {
        expect((await running(w)).status === "not running", "status says running before any start")
        expect((await w.daemonPid()) === undefined, "a vibestd.pid appeared")
      }
      {
        await w.ok(["daemon"])
        const first = await running(w)
        expect(first.status === "running" && typeof first.pid === "number", `not running: ${JSON.stringify(first)}`)
        await w.ok(["daemon"])
        const second = await running(w)
        expect(second.pid === first.pid, `pid changed: ${first.pid} → ${second.pid}`)
        expect((await w.daemonPid()) === first.pid, "vibestd.pid does not name the running vibestd")
      }
      {
        const before = (await running(w)).pid
        const r = await w.run(w.repository, [binary, "daemon", "--foreground"], { timeoutMs: 15_000 })
        expect(
          r.code === 0 && /already running/.test(r.stdout + r.stderr),
          `second vibestd: ${r.code} ${r.stdout}${r.stderr}`,
        )
        expect((await running(w)).pid === before, "the first vibestd changed")
      }
      {
        const before = (await running(w)).pid!
        {
          const r = await w.tty(["daemon", "restart"], "y\n")
          expect(r.code === 0, `daemon restart exited ${r.code}: ${r.stdout}${r.stderr}`)
        }
        await until("a new vibestd", async () => {
          const d = await running(w)
          return d.status === "running" && d.pid !== before
        })
        expect(!alive(before), `old vibestd ${before} still alive`)
      }
    },
  },
  {
    id: "D5",
    title: "a request without the protocol header, or an old one, is refused",
    run: async (w) => {
      await w.ok(["daemon"])
      for (const headers of [undefined, [["vibest-protocol", "0"]]]) {
        const reply = await raw(w, {
          jsonrpc: "2.0",
          id: "1",
          method: "List",
          params: {},
          ...(headers ? { headers } : {}),
        })
        expect(JSON.stringify(reply).includes("ProtocolRejected"), `not refused: ${JSON.stringify(reply)}`)
      }
      expect((await running(w)).status === "running", "vibestd stopped answering")
    },
  },
  {
    id: "D6",
    title: "a caller claiming a session that does not exist is refused",
    run: async (w) => {
      await w.ok(["daemon"])
      const r = await w.vibest(["ls"], { env: { VIBEST_SESSION_ID: "deadbeef" } })
      expect(r.code !== 0, `ls as an unknown session exited 0: ${r.stdout}`)
      expect(/InvalidCaller|Forbidden|NoSuchSession/.test(r.stderr), `unexpected refusal: ${r.stderr}`)
    },
  },
  {
    id: "D10",
    title:
      "vibest events prints a session's facts, or all facts, as JSON lines in order, --follow prints later facts once each, and an unknown session fails with NoSuchSession",
    run: async (w) => {
      const p = await piProject(w, "d10")
      let follower: ReturnType<typeof Bun.spawn> | undefined
      try {
        p.model.release()
        const sub = await p.runSub("d10")
        await until("the subagent's execution ended", () => p.idle(sub), 60_000)
        await expectReplied(w, sub)
        const events = (...args: Array<string>) => w.vibest(["events", ...args], { cwd: p.repo, env: p.env })
        const own = printed((await events("--session", sub)).stdout)
        const recorded = factsOf(w, sub)
        expect(
          own.map((f) => f.type).join() === recorded.join() &&
            own.every((f, i) => f.aggregate === sub && f.seq === i + 1),
          `events --session printed ${own.map((f) => `${f.seq} ${f.type}`).join(", ")}, not ${recorded.join(", ")}`,
        )
        const all = printed((await events()).stdout)
        const rising = new Map<string, number>()
        for (const f of all) {
          expect(f.seq > (rising.get(f.aggregate) ?? 0), `${f.aggregate} seq ${f.seq} did not rise in the whole log`)
          rising.set(f.aggregate, f.seq)
        }
        expect(
          own.every((f) => all.some((a) => a.aggregate === sub && a.seq === f.seq && a.type === f.type)),
          "the whole log lacks facts of the session",
        )

        const cut = Math.max(1, Math.floor(own.length / 2))
        const rest = printed((await events("--session", sub, "--after", String(cut))).stdout)
        expect(
          rest.map((f) => f.seq).join() ===
            own
              .slice(cut)
              .map((f) => f.seq)
              .join(),
          `--after ${cut} printed seqs ${rest.map((f) => f.seq).join(", ")}, not ${own
            .slice(cut)
            .map((f) => f.seq)
            .join(", ")}`,
        )
        const orphan = await events("--after", "1")
        expect(
          orphan.code !== 0 && orphan.stdout === "",
          `--after without --session exited ${orphan.code}: ${orphan.stdout}`,
        )

        const negative = await events("--session", sub, "--after=-1")
        expect(
          negative.code !== 0 && negative.stdout === "",
          `--after=-1 exited ${negative.code}: ${negative.stdout}${negative.stderr}`,
        )

        follower = Bun.spawn([binary, "events", "--session", sub, "--after", String(cut), "--follow"], {
          cwd: p.repo,
          env: w.env(p.env),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        })
        const decoder = new TextDecoder()
        let heard = ""
        void (async () => {
          for await (const chunk of follower!.stdout as ReadableStream<Uint8Array>) heard += decoder.decode(chunk)
        })()
        const lines = () => printed(heard.slice(0, heard.lastIndexOf("\n") + 1))
        await until("the follower printed the facts so far", () => lines().length >= own.length - cut, 30_000)
        await p.vibestSend(sub, ask("d10-again"))
        await until(
          "the follower printed the second execution",
          () => lines().filter((f) => f.type === "execution.ended").length >= 2,
          60_000,
        )
        const followed = lines()
        const seqs = followed.map((f) => f.seq)
        expect(
          new Set(seqs).size === seqs.length && seqs.every((seq, i) => seq === cut + i + 1),
          `follow printed seqs ${seqs.join(", ")}`,
        )
        expect(
          followed.map((f) => f.type).join() ===
            factsOf(w, sub)
              .slice(cut, cut + followed.length)
              .join(),
          "follow printed facts that differ from the recorded ones",
        )

        const unknown = await events("--session", crypto.randomUUID())
        expect(
          unknown.code !== 0 && unknown.stdout === "" && unknown.stderr.includes("NoSuchSession"),
          `unknown session exited ${unknown.code}: ${unknown.stdout}${unknown.stderr}`,
        )
      } finally {
        follower?.kill()
        await p.close()
      }
    },
  },
]

export default checks
