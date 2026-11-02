import net from "node:net"
import path from "node:path"

import type { Check } from "../check.ts"
import { alive, binary, expect, until, type World } from "../world.ts"

type Status = { daemon: { status: string; pid?: number | null; protocol?: number | null } }

const status = (w: World) => w.json<Status>(["status"])
const running = async (w: World) => (await status(w)).daemon

/** One raw JSON-RPC line on vibestd's socket and the first reply line. */
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

const checks: ReadonlyArray<Check> = [
  {
    id: "D1",
    title: "status without a daemon reports not running and starts nothing",
    run: async (w) => {
      expect((await running(w)).status === "not running", "status says running before any start")
      expect((await w.daemonPid()) === undefined, "a vibestd.pid appeared")
    },
  },
  {
    id: "D2",
    title: "daemon starts vibestd in the background; a second daemon starts no other",
    run: async (w) => {
      await w.ok(["daemon"])
      const first = await running(w)
      expect(first.status === "running" && typeof first.pid === "number", `not running: ${JSON.stringify(first)}`)
      await w.ok(["daemon"])
      const second = await running(w)
      expect(second.pid === first.pid, `pid changed: ${first.pid} → ${second.pid}`)
      expect((await w.daemonPid()) === first.pid, "vibestd.pid does not name the running vibestd")
    },
  },
  {
    id: "D3",
    title: "a foreground vibestd while one runs does not take over: it says so and exits; the first keeps running",
    run: async (w) => {
      const before = (await running(w)).pid
      const r = await w.run(w.repository, [binary, "daemon", "--foreground"], { timeoutMs: 15_000 })
      expect(
        r.code === 0 && /already running/.test(r.stdout + r.stderr),
        `second vibestd: ${r.code} ${r.stdout}${r.stderr}`,
      )
      expect((await running(w)).pid === before, "the first vibestd changed")
    },
  },
  {
    id: "D4",
    title: "daemon restart when idle replaces vibestd",
    run: async (w) => {
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
    },
  },
  {
    id: "D5",
    title: "a request without the protocol header, or an old one, is refused",
    run: async (w) => {
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
      const r = await w.vibest(["ls"], { env: { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "deadbeef" } })
      expect(r.code !== 0, `ls as an unknown session exited 0: ${r.stdout}`)
      expect(/InvalidCaller|Forbidden|NoSuchSession/.test(r.stderr), `unexpected refusal: ${r.stderr}`)
    },
  },
]

export default checks
