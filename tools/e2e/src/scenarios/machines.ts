import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, delegatingModel, piDir } from "../fake-model.ts"
import { alive, binary, expect, readDb, row, Skip, until, type World } from "../world.ts"

type Machine = { name: string; id: string; state: string; reason?: string }
type Listed = { id: string; machine?: string; runtime?: string; address?: { machine: string; id: string } }
type HcMachine = { id: string; name: string; session?: string | null }
type MachineView = {
  runtimes?: Array<{ kind: string; status: string; here: { visible: boolean; as?: string; note?: string } }>
}

export const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

export const fakeSsh = (root: string, exports: string, empty: string) =>
  [
    "#!/bin/sh",
    `[ "$1" = -G ] && { [ "$3" = gh-shop ] && echo "hostname Example.com" || echo "hostname $3"; exit 0; }`,
    `printf '%s\\n' "$*" >> ${sh(path.join(root, "ssh.log"))}`,
    `echo $$ >> ${sh(path.join(root, "ssh.pids"))}`,
    `[ -e ${sh(path.join(root, "down"))} ] && { echo "ssh: connect to host b-host port 22: Connection refused" >&2; exit 255; }`,
    `[ -e ${sh(path.join(root, "slow"))} ] && sleep "$(cat ${sh(path.join(root, "slow"))})"`,
    "host=",
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    "    -O) exit 0;;",
    "    -[bcDEeFIiJLlmopQRSWw]) shift 2;;",
    "    -[bcDEeFIiJLlmopQRSWw]*) shift;;",
    '    --) shift; [ -z "$host" ] && { host=$1; shift; }; break;;',
    "    -*) shift;;",
    '    *) [ -n "$host" ] && break; host=$1; shift;;',
    "  esac",
    "done",
    'command="$*"',
    'case "$host" in',
    `  *refused-host*) echo "ssh: connect to host refused-host port 22: Connection refused" >&2; exit 255;;`,
    `  *bare-host*) exec env -i HOME=${sh(empty)} PATH=/usr/bin:/bin sh -c "$command";;`,
    `  *self-host*) exec sh -c "$command";;`,
    "esac",
    `exec env ${exports} sh -c "$command"`,
    "",
  ].join("\n")

export const subModel = () => {
  const held = new Map<string, () => void>()
  const asked: Array<string> = []
  const reply = (content: string) =>
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (req) => {
      const { messages = [] } = (await req.json()) as { messages?: Array<{ content: unknown }> }
      const last = messages.at(-1)
      const body = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")
      const task = /done-(\w+)/.exec(body)?.[1]
      if (task === undefined) return new Response(reply("ok"), { headers: { "content-type": "text/event-stream" } })
      asked.push(task)
      if (task.startsWith("held")) await new Promise<void>((resolve) => held.set(task, resolve))
      return new Response(reply(`done-${task}\nstatus: completed`), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    asked: (task: string) => asked.includes(task),
    release: (task: string) => held.get(task)?.(),
    stop: () => {
      for (const go of held.values()) go()
      server.stop(true)
    },
  }
}

export const stopVibestd = async (home: string) => {
  const text = await fs.readFile(path.join(home, "vibestd.pid"), "utf8").catch(() => "{}")
  const pid = (JSON.parse(text) as { pid?: number }).pid
  if (pid === undefined || !alive(pid)) return
  process.kill(pid, "SIGTERM")
  await until(`vibestd ${pid} gone`, () => !alive(pid), 15_000)
}

const hcCore = async (w: World, tag: string, env: Record<string, string | undefined>) => {
  const hc = (...args: Array<string>) => w.run(w.root, ["hc", ...args], { env })
  const started = await hc("server", "start")
  expect(started.code === 0, `hc server start (${tag}): ${started.stderr}${started.stdout}`)
  return hc
}

const setup = async (w: World, options: { readonly bSession?: boolean } = {}) => {
  for (const bin of ["pi", "hc", "git"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
  w.ownRuntimes.add("hc")
  const bin = path.join(w.root, "bin")
  const b = path.join(w.root, "b")
  const empty = path.join(w.root, "empty-zdotdir")
  for (const dir of [bin, b, empty, ...["home", "tmp", "r", "s", "c"].map((d) => path.join(b, d))])
    await fs.mkdir(dir, { recursive: true })
  const subs = subModel()
  const main = delegatingModel("pi")
  const piA = await piDir(w, "pi-a", main.url)
  const piB = await piDir(w, "pi-b", subs.url)
  const loginPath = w.env().PATH!
  const bEnv = {
    VIBEST_HOME: path.join(b, "home"),
    PATH: loginPath,
    HC_SESSION: `${w.herdrSession.toLowerCase()}-b`,
    XDG_RUNTIME_DIR: path.join(b, "r"),
    XDG_STATE_HOME: path.join(b, "s"),
    XDG_CONFIG_HOME: path.join(b, "c"),
    PI_CODING_AGENT_DIR: piB,
    TMPDIR: path.join(b, "tmp"),
    ZDOTDIR: empty,
    HC_SOCKET: options.bSession ? undefined : path.join(b, "hc.sock"),
  }
  const exports = [
    ...(options.bSession ? ["-u HC_SOCKET"] : []),
    ...Object.entries(bEnv).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${sh(v)}`])),
  ].join(" ")
  await fs.writeFile(path.join(bin, "ssh"), fakeSsh(w.root, exports, empty), { mode: 0o755 })
  const bRepo = path.join(b, "shop")
  const cloned = await w.run(w.root, ["git", "clone", "-q", w.origin, bRepo])
  expect(cloned.code === 0, `git clone: ${cloned.stderr}`)
  for (const [cwd, url] of [
    [bRepo, "https://example.com/o/shop"],
    [w.repository, "git@gh-shop:o/shop.git"],
  ] as const) {
    const set = await w.run(cwd, ["git", "remote", "set-url", "origin", url])
    expect(set.code === 0, `git remote set-url: ${set.stderr}`)
  }
  const hcB = await hcCore(w, "b", bEnv)
  const onB = (args: ReadonlyArray<string>, cwd = bRepo) => w.run(cwd, [binary, ...args], { env: bEnv })
  const okB = async (args: ReadonlyArray<string>) => {
    const r = await onB(args)
    expect(r.code === 0, `B: vibest ${args.join(" ")} exited ${r.code}: ${r.stderr}${r.stdout}`)
    return r.stdout
  }
  await okB(["project", "add"])
  const aEnv = {
    HC_SESSION: `${w.herdrSession}-a`,
    XDG_RUNTIME_DIR: path.join(w.root, "a-r"),
    XDG_STATE_HOME: path.join(w.root, "a-s"),
    XDG_CONFIG_HOME: path.join(w.root, "a-c"),
    PI_CODING_AGENT_DIR: piA,
    PATH: `${bin}:${loginPath}`,
    ZDOTDIR: empty,
  }
  for (const dir of ["a-r", "a-s", "a-c"]) await fs.mkdir(path.join(w.root, dir), { recursive: true })
  const hcA = await hcCore(w, "a", aEnv)
  await w.stopDaemon()
  const daemonA = await w.run(w.repository, [binary, "daemon"], { env: aEnv })
  expect(daemonA.code === 0, `A: vibest daemon: ${daemonA.stderr}`)
  await w.startMain({
    harness: "pi",
    runtime: "hc",
    env: { PI_CODING_AGENT_DIR: piA },
    processEnv: { CLAUDE_CONFIG_DIR: undefined },
    extra: ["--runtime", "hc"],
    name: "a-main",
    hc: { run: hcA },
    timeoutMs: 60_000,
  })
  const onA = (args: ReadonlyArray<string>) => w.run(w.repository, [binary, ...args], { env: aEnv })
  const okA = async (args: ReadonlyArray<string>) => {
    const r = await onA(args)
    expect(r.code === 0, `A: vibest ${args.join(" ")} exited ${r.code}: ${r.stderr}${r.stdout}`)
    return r.stdout
  }
  const bDb = <A>(sql: string, ...args: Array<string>) => {
    const db = readDb(path.join(bEnv.VIBEST_HOME, "vibest.db"))
    try {
      return db.query(sql).get(...args) as A | null
    } finally {
      db.close()
    }
  }
  const identity = async (home: string) =>
    JSON.parse(await fs.readFile(path.join(home, "identity.json"), "utf8")) as { id: string; name: string }
  const notices = (address: string, marker: string) =>
    row<{ n: number }>(
      w,
      "SELECT count(*) AS n FROM inbox WHERE content LIKE ? AND content LIKE ?",
      `${address}:%`,
      `%done-${marker}%`,
    )?.n ?? 0
  const run = async (marker: string, machine = "mb") => {
    const printed = (JSON.parse(await okA(["run", "--machine", machine, "pi", "--", ask(marker)])) as { id: string }).id
    expect(printed.startsWith(`${machine}/`) && /^[0-9a-f-]{36}$/.test(printed.slice(machine.length + 1)), printed)
    return printed.slice(0, machine.length + 9)
  }
  const stop = async () => {
    subs.stop()
    main.stop()
    await stopVibestd(bEnv.VIBEST_HOME)
    await hcB("server", "stop")
    await hcA("server", "stop")
  }
  const aSocket = w.hcSocket
  const log = path.join(w.root, "ssh.log")
  return { b, bEnv, aEnv, aSocket, onA, okA, onB, okB, bDb, identity, notices, run, subs, main, log, stop, hcA, hcB }
}

type Setup = Awaited<ReturnType<typeof setup>>

const checks: ReadonlyArray<Check> = [
  {
    id: "M1",
    title:
      "machine add over a fake ssh records B's id, B records A as a peer, a second name for the same B is refused; vibest run --machine without --runtime finds B's checkout cloned with another URL form (A's remote an ssh alias) and starts a session on B in the runtime of A's main agent and none on A, A's main agent gets one notice with B's text, B's outbox empties; send, result, peek and archive forward to B",
    run: async (w) => {
      let s: Setup | undefined
      try {
        s = await setup(w)
        const added = await s.okA(["machine", "add", "mb", "b-host"])
        const b = await s.identity(s.bEnv.VIBEST_HOME)
        const a = await s.identity(w.vibestHome)
        expect(added.includes(`(${b.id.slice(0, 8)})`), `machine add: ${added}`)
        const ssh = await fs.readFile(s.log, "utf8")
        expect(ssh.includes("BatchMode=yes") && ssh.includes("b-host") && ssh.includes("connect"), `ssh argv: ${ssh}`)
        let m: Machine | undefined
        await until(
          "mb connected",
          async () => {
            m = (JSON.parse(await s!.okA(["machine", "ls"])) as Array<Machine>)[0]
            return m?.state === "connected"
          },
          30_000,
        )
        expect(m?.state === "connected" && m.id === b.id, `machine ls: ${JSON.stringify(m)}`)
        const peer = s.bDb<{ id: string; callsMe: string; n: number }>(
          "SELECT id, calls_me AS callsMe, (SELECT count(*) FROM peer) AS n FROM peer",
        )
        expect(peer?.n === 1 && peer.id === a.id && peer.callsMe === "mb", `B's peer rows: ${JSON.stringify(peer)}`)
        const again = await s.onA(["machine", "add", "mb-again", "b-host"])
        expect(again.code !== 0 && again.stderr.includes("already added as mb"), `second add: ${again.stderr}`)

        const address = await s.run("mone")
        expect(/^mb\/[0-9a-f]{8}$/.test(address), `run --machine printed ${address}`)
        const id8 = address.slice(3)
        const bRows = (JSON.parse(await s.okB(["ls"])) as { sessions: Array<Listed> }).sessions
        expect(
          bRows.some((r) => r.id?.startsWith(id8) && r.runtime === "hc"),
          `B's ls (no --runtime: A sends its main agent's hc): ${JSON.stringify(bRows)}`,
        )
        expect(row(w, "SELECT id FROM session WHERE id LIKE ?", `${id8}%`) === undefined, "A has a session row")
        await until("the notice on A", () => s!.notices(address, "mone") === 1, 120_000)
        await until(
          "A's main agent saw it",
          () => s!.main.seen.some((m) => m.includes(address) && m.includes("done-mone")),
          120_000,
        )
        await until(
          "B's outbox empty",
          () => s!.bDb<{ n: number }>("SELECT count(*) AS n FROM outbox")?.n === 0,
          30_000,
        )
        await s.okA(["send", address, "--", ask("mtwo")])
        await until("the second notice", () => s!.notices(address, "mtwo") === 1, 120_000)
        expect(s.notices(address, "mone") === 1, "the first notice repeated")
        const result = JSON.parse(await s.okA(["result", address])) as { id: string; machine: string }
        expect(result.machine === "mb" && result.id.startsWith(address), `result: ${JSON.stringify(result)}`)
        await s.okA(["peek", address])
        const listed = (JSON.parse(await s.okA(["ls"])) as { sessions: Array<Listed> }).sessions
        expect(
          listed.some((r) => r.machine === "mb" && r.id?.startsWith(address)),
          `A's ls: ${JSON.stringify(listed)}`,
        )
        await s.okA(["archive", address])
      } finally {
        await s?.stop()
      }
    },
  },
  {
    id: "M2",
    title:
      "recovery: a result written while A's vibestd is stopped, and one written while the ssh child is killed, each arrive once, the second over a reconnect whose ssh takes 15 s to connect; A's ls shows mb not connected meanwhile",
    run: async (w) => {
      let s: Setup | undefined
      try {
        s = await setup(w)
        await s.okA(["machine", "add", "mb", "b-host"])
        const first = await s.run("heldone")
        await until("B's model got the first task", () => s!.subs.asked("heldone"), 120_000)
        await w.stopDaemon()
        s.subs.release("heldone")
        await until("B's outbox row", () => s!.bDb<{ n: number }>("SELECT count(*) AS n FROM outbox")?.n === 1, 60_000)
        await s.okA(["daemon"])
        await until("the first notice", () => s!.notices(first, "heldone") === 1, 60_000)

        const second = await s.run("heldtwo")
        await until("B's model got the second task", () => s!.subs.asked("heldtwo"), 120_000)
        const pids = (await fs.readFile(path.join(w.root, "ssh.pids"), "utf8")).trim().split("\n")
        await fs.writeFile(path.join(w.root, "down"), "")
        process.kill(Number(pids.at(-1)), "SIGKILL")
        await until(
          "mb not connected in A's ls",
          async () =>
            (JSON.parse(await s!.okA(["ls"])) as { machines: Array<{ name: string; state: string }> }).machines.some(
              (m) => m.name === "mb" && m.state !== "connected",
            ),
          30_000,
        )
        s.subs.release("heldtwo")
        await until("B's outbox row", () => s!.bDb<{ n: number }>("SELECT count(*) AS n FROM outbox")?.n === 1, 60_000)
        await fs.writeFile(path.join(w.root, "slow"), "15")
        await fs.rm(path.join(w.root, "down"))
        await until("the second notice", () => s!.notices(second, "heldtwo") === 1, 120_000)
        await fs.rm(path.join(w.root, "slow"))
        await Bun.sleep(2_000)
        expect(s.notices(first, "heldone") === 1 && s.notices(second, "heldtwo") === 1, "a notice repeated")
      } finally {
        await s?.stop()
      }
    },
  },
  {
    id: "M3",
    title:
      "two A's on one B: the second A adds B over an ssh that takes 15 s to connect; B records two peers; the second A gets nothing from the first's task and cannot list it",
    run: async (w) => {
      let s: Setup | undefined
      try {
        s = await setup(w)
        await s.okA(["machine", "add", "mb", "b-host"])
        const address = await s.run("m3")
        await until("the notice on A", () => s!.notices(address, "m3") === 1, 120_000)
        const a2 = { ...s.aEnv, VIBEST_HOME: path.join(w.root, "a2") }
        await fs.mkdir(a2.VIBEST_HOME, { recursive: true })
        await fs.writeFile(path.join(w.root, "slow"), "15")
        const added = await w.run(w.repository, [binary, "machine", "add", "mb", "b-host"], { env: a2 })
        await fs.rm(path.join(w.root, "slow"))
        expect(added.code === 0, `second A machine add over a 15 s ssh connect: ${added.stderr}`)
        const peers = s.bDb<{ n: number }>("SELECT count(*) AS n FROM peer")?.n
        expect(peers === 2, `B's peer rows: ${peers}`)
        const listed = await w.run(w.repository, [binary, "ls"], { env: a2 })
        expect(
          listed.code === 0 && !listed.stdout.includes(address.slice(3)),
          `second A's ls: ${listed.stdout}${listed.stderr}`,
        )
        const got = await w.run(w.repository, [binary, "result", address], { env: a2 })
        expect(got.code !== 0, `second A reached the first's session: ${got.stdout}`)
        await stopVibestd(a2.VIBEST_HOME)
      } finally {
        await s?.stop()
      }
    },
  },
  {
    id: "M4",
    title:
      "forget: machine rm with a task held open; its result waits in B's outbox; machine add under another name delivers it once",
    run: async (w) => {
      let s: Setup | undefined
      try {
        s = await setup(w)
        await s.okA(["machine", "add", "mb", "b-host"])
        const address = await s.run("heldfour")
        await until("B's model got the task", () => s!.subs.asked("heldfour"), 120_000)
        await s.okA(["machine", "rm", "mb"])
        s.subs.release("heldfour")
        await until("B's outbox row", () => s!.bDb<{ n: number }>("SELECT count(*) AS n FROM outbox")?.n === 1, 60_000)
        await s.okA(["machine", "add", "mb2", "b-host"])
        await until(
          "the notice under the new name",
          () => s!.notices(`mb2/${address.slice(3)}`, "heldfour") === 1,
          60_000,
        )
        expect(s.notices(address, "heldfour") === 0, "a notice under the old name")
      } finally {
        await s?.stop()
      }
    },
  },
  {
    id: "M5",
    title:
      "clear failures: an unknown machine, vibest missing on the target, ssh exiting 255, the target being this vibestd, a different vibestd behind the target, a commit B does not have, and agents running vibest connect or machine add",
    run: async (w) => {
      let s: Setup | undefined
      try {
        s = await setup(w)
        const failed = async (args: ReadonlyArray<string>, text: string) => {
          const r = await s!.onA(args)
          expect(r.code !== 0 && r.stderr.includes(text), `vibest ${args.join(" ")}: ${r.code} ${r.stderr}${r.stdout}`)
        }
        await failed(["run", "--machine", "nosuch", "pi", "--", "x"], `unknown machine "nosuch"`)
        await failed(["machine", "add", "m", "bare-host"], "vibest is not installed on m")
        await failed(["machine", "add", "m", "refused-host"], "Connection refused")
        await failed(["machine", "add", "m", "self-host"], "m is this vibestd")
        expect(JSON.parse(await s.okA(["machine", "ls"])).length === 0, "a failed add was recorded")

        await s.okA(["machine", "add", "mb", "b-host"])
        await fs.writeFile(path.join(w.repository, "local.txt"), "only on A\n")
        for (const argv of [
          ["git", "add", "."],
          ["git", "commit", "-q", "-m", "local"],
        ])
          expect((await w.run(w.repository, argv)).code === 0, argv.join(" "))
        await failed(["run", "--machine", "mb", "--runtime", "hc", "pi", "--", "x"], "push it and fetch it there")

        const agent = { VIBEST_SESSION_ID: crypto.randomUUID() }
        for (const args of [["connect"], ["machine", "add", "x", "b-host"]]) {
          const r = await w.run(w.repository, [binary, ...args], { env: { ...s.aEnv, ...agent } })
          expect(
            r.code !== 0 && /agent may not run|only the user/.test(r.stderr),
            `agent ran vibest ${args.join(" ")}: ${r.stderr}`,
          )
        }

        await fs.writeFile(path.join(w.root, "down"), "")
        await stopVibestd(s.bEnv.VIBEST_HOME)
        await fs.rename(path.join(s.bEnv.VIBEST_HOME, "identity.json"), path.join(s.b, "identity.json.old"))
        await fs.rm(path.join(w.root, "down"))
        await until(
          "mb different",
          async () => (JSON.parse(await s!.okA(["machine", "ls"])) as Array<Machine>)[0]?.state === "different",
          60_000,
        )
        await failed(["run", "--machine", "mb", "pi", "--", "x"], "now answers as a different vibestd")
      } finally {
        await s?.stop()
      }
    },
  },
  {
    id: "M6",
    title:
      "terminals on another machine: machine add mirrors B's hc core into A's hc; a run --machine row's address is A's hc terminal; typing into it on A starts a typed turn on B whose result arrives once; a rename in hc is followed; a mirror removed in hc is added back by the next ls and result; machine rm removes it from hc whatever its name",
    run: async (w) => {
      let s: Setup | undefined
      try {
        s = await setup(w, { bSession: true })
        const hcRows = async () => {
          const r = await s!.hcA("machine", "ls", "--json")
          expect(r.code === 0, `hc machine ls on A: ${r.stderr}`)
          const parsed = JSON.parse(r.stdout) as Array<HcMachine> | { machines: Array<HcMachine> }
          return Array.isArray(parsed) ? parsed : parsed.machines
        }
        const status = JSON.parse((await s.hcB("server", "status", "--json")).stdout) as {
          core?: { id?: string }
          id?: string
        }
        const core = status.core?.id ?? status.id ?? ""
        expect(core !== "", `B's hc core id: ${JSON.stringify(status)}`)
        const added = await s.okA(["machine", "add", "mb", "b-host"])
        expect(added.includes("hc: added mb to herdr-core here"), `machine add: ${added}`)
        const mirrored = (await hcRows()).filter((m) => m.id === core)
        expect(
          mirrored.length === 1 && mirrored[0]!.name === "mb" && mirrored[0]!.session === s.bEnv.HC_SESSION,
          `A's hc machines: ${JSON.stringify(await hcRows())}`,
        )
        const ssh = await fs.readFile(s.log, "utf8")
        expect(ssh.includes(`HC_SESSION=${s.bEnv.HC_SESSION} exec`), `hc's own dial is not in the ssh log: ${ssh}`)
        const machines = JSON.parse(await s.okA(["machine", "ls"])) as Array<MachineView>
        const hc = machines[0]?.runtimes?.find((r) => r.kind === "hc")
        expect(
          hc?.status === "online" && hc.here.visible && hc.here.as === "mb",
          `machine ls: ${JSON.stringify(machines)}`,
        )

        const address = await s.run("msix")
        const id8 = address.slice(3)
        const bRow = (JSON.parse(await s.okB(["ls"])) as { sessions: Array<Listed> }).sessions.find((r) =>
          r.id?.startsWith(id8),
        )
        expect(bRow?.runtime === "hc", `B's row: ${JSON.stringify(bRow)}`)
        const shown = async () =>
          (JSON.parse(await s!.okA(["ls"])) as { sessions: Array<Listed> }).sessions.find((r) =>
            r.id?.startsWith(address),
          )
        let first: Listed | undefined
        await until(
          "A's row has its terminal",
          async () => {
            first = await shown()
            return (first?.address?.id ?? "") !== ""
          },
          60_000,
        )
        expect(
          /^mb\/t\d+@/.test(first?.address?.id ?? "") && (first?.address?.id.endsWith(`@${s.aSocket}`) ?? false),
          `A's row: ${JSON.stringify(first)}`,
        )
        const terminal = first!.address!.id.split("@")[0]!
        const byLabel = await s.hcA("ls", "--json", "--label", `vibest.session=${bRow!.id}`)
        expect(byLabel.stdout.includes(`"${terminal}"`), `hc ls on A: ${byLabel.stdout}${byLabel.stderr}`)
        await until("the first notice", () => s!.notices(address, "msix") === 1, 120_000)

        const typed = await s.hcA("send", terminal, ask("mstep"))
        expect(typed.code === 0, `hc send on A: ${typed.stderr}`)
        await until("B saw the typed turn", () => s!.subs.asked("mstep"), 120_000)
        await until(
          "B recorded a typed turn",
          () =>
            (s!.bDb<{ n: number }>(
              "SELECT count(*) AS n FROM event WHERE session_id = ? AND type = 'turn.start' AND json_extract(data, '$.typed') IS NOT NULL",
              bRow!.id!,
            )?.n ?? 0) === 1,
          60_000,
        )
        await until("the typed turn's notice", () => s!.notices(address, "mstep") === 1, 120_000)

        const renamed = await s.hcA("machine", "rename", "mb", "mbx")
        expect(renamed.code === 0, `hc machine rename: ${renamed.stderr}`)
        const followed = await shown()
        expect(followed?.address?.id.startsWith("mbx/t") === true, `after the rename: ${JSON.stringify(followed)}`)
        expect((await hcRows()).length === 1, `a second mirror after the rename: ${JSON.stringify(await hcRows())}`)

        const dials = (await fs.readFile(s.log, "utf8")).split("\n").filter((l) => l.includes("vibest connect")).length
        expect((await s.hcA("machine", "rm", "mbx")).code === 0, "hc machine rm mbx")
        const repaired = await shown()
        expect(repaired?.address?.id.startsWith("mb/t") === true, `ls after hc machine rm: ${JSON.stringify(repaired)}`)
        expect(
          (await hcRows()).some((m) => m.id === core && m.name === "mb"),
          `A's hc after the repair: ${JSON.stringify(await hcRows())}`,
        )
        expect((await s.hcA("machine", "rm", "mb")).code === 0, "hc machine rm mb")
        const got = JSON.parse(await s.okA(["result", address])) as Listed
        expect(got.address?.id.startsWith("mb/t") === true, `result after hc machine rm: ${JSON.stringify(got)}`)
        const dialsAfter = (await fs.readFile(s.log, "utf8")).split("\n").filter((l) => l.includes("vibest connect"))
        expect(dialsAfter.length === dials, "vibest reconnected to repair")

        expect((await s.hcA("machine", "rename", "mb", "vps")).code === 0, "hc machine rename mb vps")
        const removed = JSON.parse(await s.okA(["machine", "rm", "mb"])) as { notes: Array<unknown> }
        expect(removed.notes.length === 0, `machine rm notes: ${JSON.stringify(removed)}`)
        expect(
          !(await hcRows()).some((m) => m.id === core),
          `A's hc after machine rm: ${JSON.stringify(await hcRows())}`,
        )
        const again = await s.okA(["machine", "add", "mb", "b-host"])
        expect(again.includes("hc: added mb"), `machine add again: ${again}`)
        expect(
          (await hcRows()).some((m) => m.id === core && m.name === "mb"),
          "added again",
        )
      } finally {
        await s?.stop()
      }
    },
  },
]

export default checks
