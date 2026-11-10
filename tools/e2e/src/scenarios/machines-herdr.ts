import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, delegatingModel, piDir } from "../fake-model.ts"
import { agentName, binary, expect, readDb, row, Skip, until, writeEvidence, type World } from "../world.ts"
import { sh, stopVibestd, subModel } from "./machines.ts"

type Listed = { id: string; machine?: string; runtime?: string; address?: { machine: string; id: string } }
type Profile = { id: string; label: string; target: string; session: string; enabled?: boolean }
type MachineView = {
  runtimes?: Array<{ kind: string; status: string; here: { visible: boolean; as?: string; note?: string } }>
}

const fakeSsh = (log: string, exports: string, bare: string) =>
  [
    "#!/bin/sh",
    `[ "$1" = -G ] && { [ "$3" = gh-shop ] && echo "hostname Example.com" || echo "hostname $3"; exit 0; }`,
    `printf '%s\\n' "$*" >> ${sh(log)}`,
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
    `  *bare-host*) exec env -i HOME=${sh(bare)} PATH=/usr/bin:/bin sh -c "$command";;`,
    "esac",
    `exec env ${exports} sh -c "$command"`,
    "",
  ].join("\n")

const setup = async (w: World, evidence: string) => {
  for (const bin of ["pi", "herdr", "git"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
  const bin = path.join(w.root, "bin")
  const b = path.join(w.root, "b")
  const a = path.join(w.root, "a")
  const empty = path.join(w.root, "empty-zdotdir")
  for (const dir of [bin, empty, ...["home", "tmp", "r", "s", "c"].flatMap((d) => [path.join(b, d), path.join(a, d)])])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const subs = subModel()
  const main = delegatingModel("pi")
  const piA = await piDir(w, "pi-a", main.url)
  const piB = await piDir(w, "pi-b", subs.url)
  const loginPath = w.env().PATH!
  const sessions = { a: `${w.herdrSession}-a`, b: `${w.herdrSession}-b` }
  const xdg = (dir: string) => ({
    XDG_RUNTIME_DIR: path.join(dir, "r"),
    XDG_STATE_HOME: path.join(dir, "s"),
    XDG_CONFIG_HOME: path.join(dir, "c"),
  })
  const herdrEnv = {
    a: { ...xdg(a), PATH: `${bin}:${loginPath}`, PI_CODING_AGENT_DIR: piA, ZDOTDIR: empty },
    b: {
      ...xdg(b),
      PATH: loginPath,
      VIBEST_HOME: path.join(b, "home"),
      PI_CODING_AGENT_DIR: piB,
      TMPDIR: path.join(b, "tmp"),
      ZDOTDIR: empty,
    },
  }
  const servers: Array<ReturnType<typeof Bun.spawn>> = []
  const herdrOn =
    (side: "a" | "b") =>
    (...args: Array<string>) =>
      w.run(w.root, ["herdr", ...args], { env: herdrEnv[side] })
  const serve = async (side: "a" | "b") => {
    const argv = side === "a" ? ["server", "--session", sessions.a] : ["--session", sessions.b, "remote-client-bridge"]
    const server = Bun.spawn([Bun.which("herdr")!, ...argv], {
      env: w.env(herdrEnv[side]),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    server.unref()
    servers.push(server)
    let socket = ""
    await until(
      `herdr session ${sessions[side]}`,
      async () => {
        const listed = await herdrOn(side)("session", "list", "--json")
        const found = (
          JSON.parse(listed.stdout || "{}") as {
            sessions?: Array<{ name: string; socket_path: string; running: boolean }>
          }
        ).sessions?.find((s) => s.name === sessions[side] && s.running)
        socket = found?.socket_path ?? ""
        return (
          socket !== "" &&
          (await fs.stat(socket).then(
            () => true,
            () => false,
          ))
        )
      },
      20_000,
    )
    return socket
  }
  const socketA = await serve("a")
  const socketB = await serve("b")
  const bEnv = { ...herdrEnv.b, HERDR_SOCKET_PATH: socketB }
  const exports = Object.entries(bEnv)
    .map(([k, v]) => `${k}=${sh(v)}`)
    .join(" ")
  const log = path.join(w.root, "ssh.log")
  await fs.writeFile(path.join(bin, "ssh"), fakeSsh(log, exports, empty), { mode: 0o755 })
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
  const okB = async (args: ReadonlyArray<string>) => {
    const r = await w.run(bRepo, [binary, ...args], { env: bEnv })
    expect(r.code === 0, `B: vibest ${args.join(" ")} exited ${r.code}: ${r.stderr}${r.stdout}`)
    return r.stdout
  }
  await okB(["project", "add"])
  const aEnv = herdrEnv.a
  await w.stopDaemon()
  const daemonA = await w.run(w.repository, [binary, "daemon"], { env: aEnv })
  expect(daemonA.code === 0, `A: vibest daemon: ${daemonA.stderr}`)
  await w.startMain({
    harness: "pi",
    session: sessions.a,
    socket: socketA,
    env: { PI_CODING_AGENT_DIR: piA },
    processEnv: { ...aEnv, CLAUDE_CONFIG_DIR: undefined },
    timeoutMs: 60_000,
  })
  const onA = (args: ReadonlyArray<string>) => w.run(w.repository, [binary, ...args], { env: aEnv })
  const okA = async (args: ReadonlyArray<string>) => {
    const r = await onA(args)
    expect(r.code === 0, `A: vibest ${args.join(" ")} exited ${r.code}: ${r.stderr}${r.stdout}`)
    return r.stdout
  }
  const herdrA = herdrOn("a")
  const profiles = async () => {
    const r = await herdrA("machine", "list", "--json")
    await fs.appendFile(path.join(evidence, "M7-herdr-machine-list.txt"), `${r.code}\n${r.stdout}${r.stderr}\n`)
    expect(r.code === 0, `herdr machine list on A: ${r.stderr}`)
    const parsed = JSON.parse(r.stdout) as Array<Profile> | Record<string, Array<Profile>>
    return Array.isArray(parsed) ? parsed : (parsed.machines ?? parsed.ssh ?? parsed.profiles ?? [])
  }
  const bDb = <A>(sql: string, ...args: Array<string>) => {
    const db = readDb(path.join(bEnv.VIBEST_HOME, "vibest.db"))
    try {
      return db.query(sql).get(...args) as A | null
    } finally {
      db.close()
    }
  }
  const notices = (address: string, marker: string) =>
    row<{ n: number }>(
      w,
      "SELECT count(*) AS n FROM inbox WHERE content LIKE ? AND content LIKE ?",
      `${address}:%`,
      `%done-${marker}%`,
    )?.n ?? 0
  const stop = async () => {
    subs.stop()
    main.stop()
    await stopVibestd(bEnv.VIBEST_HOME)
    for (const side of ["a", "b"] as const) {
      await herdrOn(side)("session", "stop", sessions[side])
      await herdrOn(side)("session", "delete", sessions[side])
    }
    for (const server of servers) if (server.exitCode === null) server.kill()
  }
  return { sessions, bEnv, aEnv, onA, okA, okB, herdrA, profiles, bDb, notices, log, subs, stop }
}

type Setup = Awaited<ReturnType<typeof setup>>

const checks: ReadonlyArray<Check> = [
  {
    id: "M7",
    title:
      "herdr terminals on another machine: machine add saves B's herdr session as a herdr machine on A (isolated XDG state, through herdr's own command, which never installs: against a host without herdr it fails and saves nothing); a run --machine row's address names B's pane under that machine and herdr --machine reaches B's agent; a prompt typed there through herdr starts a typed turn on B whose result arrives once; a profile removed in herdr is added back by the next ls; machine rm removes it",
    run: async (w, evidence) => {
      let s: Setup | undefined
      try {
        s = await setup(w, evidence)
        const label = `mb/${s.sessions.b}`
        const bare = await s.herdrA("machine", "add", "bare-host", "--label", "bare", "--remote-session", "x")
        await writeEvidence(path.join(evidence, "M7-bare-add.txt"), `${bare.code}\n${bare.stdout}${bare.stderr}`)
        expect(bare.code !== 0, `herdr machine add against a host without herdr: ${bare.stdout}${bare.stderr}`)
        expect((await s.profiles()).length === 0, `a failed herdr machine add saved a machine`)

        const added = await s.okA(["machine", "add", "mb", "b-host"])
        await writeEvidence(path.join(evidence, "M7-machine-add.txt"), added)
        expect(added.includes(`herdr: added ${label} here`), `machine add: ${added}`)
        const saved = await s.profiles()
        expect(
          saved.length === 1 && saved[0]!.label === label && saved[0]!.session === s.sessions.b,
          `A's herdr machines: ${JSON.stringify(saved)}`,
        )
        const machines = JSON.parse(await s.okA(["machine", "ls"])) as Array<MachineView>
        const herdr = machines[0]?.runtimes?.find((r) => r.kind === "herdr")
        expect(herdr?.here.visible === true && herdr.here.as === label, `machine ls: ${JSON.stringify(machines)}`)

        const printed = (
          JSON.parse(await s.okA(["run", "--machine", "mb", "pi", "--", ask("hseven")])) as { id: string }
        ).id
        const id = printed.slice(3)
        const bRow = (JSON.parse(await s.okB(["ls"])) as { sessions: Array<Listed> }).sessions.find((r) =>
          id.startsWith(r.id.slice(0, 8)),
        )
        expect(bRow?.runtime === "herdr", `B's row: ${JSON.stringify(bRow)}`)
        const name = agentName(bRow!.id)
        const shown = async () =>
          (JSON.parse(await s!.okA(["ls"])) as { sessions: Array<Listed> }).sessions.find((r) =>
            r.id.startsWith(printed.slice(0, 11)),
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
        const pattern = new RegExp(`^${s.sessions.b}/w\\d+:p\\d+/${name}@${label}$`)
        expect(pattern.test(first?.address?.id ?? ""), `A's row: ${JSON.stringify(first)}`)
        const got = await s.herdrA("--machine", label, "agent", "get", name)
        await writeEvidence(path.join(evidence, "M7-agent-get.txt"), `${got.code}\n${got.stdout}${got.stderr}`)
        expect(got.code === 0 && got.stdout.includes(name), `herdr --machine agent get: ${got.stdout}${got.stderr}`)
        await until("the first notice", () => s!.notices(printed.slice(0, 11), "hseven") === 1, 120_000)

        const typed = await s.herdrA("--machine", label, "agent", "prompt", name, ask("hstep"))
        expect(typed.code === 0, `herdr --machine agent prompt: ${typed.stdout}${typed.stderr}`)
        await until("B saw the typed turn", () => s!.subs.asked("hstep"), 120_000)
        await until(
          "B recorded a typed turn",
          () =>
            (s!.bDb<{ n: number }>(
              "SELECT count(*) AS n FROM event WHERE session_id = ? AND type = 'turn.start' AND json_extract(data, '$.typed') IS NOT NULL",
              bRow!.id,
            )?.n ?? 0) === 1,
          60_000,
        )
        await until("the typed turn's notice", () => s!.notices(printed.slice(0, 11), "hstep") === 1, 120_000)

        const removedInHerdr = await s.herdrA("machine", "remove", saved[0]!.id)
        expect(removedInHerdr.code === 0, `herdr machine remove: ${removedInHerdr.stderr}`)
        const repaired = await shown()
        expect(pattern.test(repaired?.address?.id ?? ""), `ls after herdr machine remove: ${JSON.stringify(repaired)}`)
        expect(
          (await s.profiles()).some((p) => p.label === label && p.session === s!.sessions.b),
          "the profile was not added back",
        )

        const removed = JSON.parse(await s.okA(["machine", "rm", "mb"])) as { notes: Array<{ plugin: string }> }
        expect(
          !removed.notes.some((note) => note.plugin === "runtime-herdr"),
          `machine rm notes: ${JSON.stringify(removed)}`,
        )
        expect((await s.profiles()).length === 0, `A's herdr after machine rm: ${JSON.stringify(await s.profiles())}`)
        expect(s.notices(printed.slice(0, 11), "hseven") === 1, "the first notice repeated")
        await writeEvidence(path.join(evidence, "M7-ssh.log"), await fs.readFile(s.log, "utf8"))
      } finally {
        await s?.stop()
      }
    },
  },
]

export default checks
