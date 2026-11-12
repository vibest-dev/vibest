import fs from "node:fs/promises"
import path from "node:path"

import { note } from "../../../reap.ts"
import type { Check } from "../check.ts"
import { ask, delegatingModel, piDir } from "../fake-model.ts"
import { agentName, binary, expect, readDb, redact, row, Skip, until, writeEvidence, type World } from "../world.ts"
import { fakeSsh, sh, stopVibestd, subModel } from "./machines.ts"

type Listed = {
  id: string
  agent?: string
  machine?: string
  runtime?: string
  address?: { machine: string; id: string }
}
type Profile = { id: string; label: string; target: string; session: string; enabled?: boolean }
type MachineView = {
  runtimes?: Array<{ kind: string; status: string; here: { visible: boolean; as?: string; note?: string } }>
}

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
  const sessions = { a: `${w.herdrSession}-a`, b: "default" }
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
    const server = Bun.spawn([Bun.which("herdr")!, "server", "--session", sessions[side]], {
      env: w.env(herdrEnv[side]),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    server.unref()
    servers.push(server)
    note(server.pid, `herdr server --session ${sessions[side]}`, w.root)
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
  const bEnv = { ...herdrEnv.b, HERDR_SOCKET_PATH: undefined }
  const exports = Object.entries(bEnv)
    .flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${sh(v)}`]))
    .join(" ")
  const log = path.join(w.root, "ssh.log")
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
  await w.startEntry({
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
    await fs.appendFile(path.join(evidence, "M7-herdr-machine-list.txt"), redact(`${r.code}\n${r.stdout}${r.stderr}\n`))
    expect(r.code === 0, `herdr machine list on A: ${r.stderr}`)
    return JSON.parse(r.stdout) as Array<Profile>
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
      "SELECT count(*) AS n FROM inbox WHERE kind = 'send' AND content LIKE ? AND content LIKE ?",
      `%<agent-id>${address}</agent-id>%`,
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
    for (const server of servers) if (server.exitCode === null) server.kill("SIGKILL")
  }
  const herdrB = herdrOn("b")
  const serverB = async (name: string) => {
    const r = await herdrB("--session", sessions.b, "status", "server", "--json")
    await fs.appendFile(path.join(evidence, `M7-b-server-${name}.json`), redact(`${r.code}\n${r.stdout}${r.stderr}\n`))
    return JSON.parse(r.stdout) as { running: boolean; capabilities?: { detached_server_daemon: boolean } | null }
  }
  const stopB = async () => {
    const stopped = await herdrB("session", "stop", sessions.b)
    expect(stopped.code === 0, `herdr session stop on B: ${stopped.stdout}${stopped.stderr}`)
    await until("B's herdr session stopped", async () => !(await serverB("stopping")).running, 20_000)
  }
  return { sessions, bEnv, aEnv, onA, okA, okB, herdrA, serve, serverB, stopB, profiles, bDb, notices, log, subs, stop }
}

type Setup = Awaited<ReturnType<typeof setup>>

const checks: ReadonlyArray<Check> = [
  {
    id: "M7",
    title:
      "herdr terminals on another machine: an agent run --machine starts opens in herdr's default session on B; machine add saves that session as a herdr machine on A (isolated XDG state, through herdr's own command, which never installs: against a host without herdr it fails and saves nothing); a plain herdr server on B is refused with a restart note and nothing saved; a run --machine row's address names B's pane under that machine and herdr --machine reaches B's agent; a prompt typed there through herdr starts a typed execution on B whose result arrives once; a profile removed in herdr is added back by the next ls; after B's session stops, B's vibestd starts it again as its own session leader for the next run --machine and the same saved machine reaches the new agent; machine rm removes it",
    run: async (w, evidence) => {
      let s: Setup | undefined
      try {
        s = await setup(w, evidence)
        const label = `mb/${s.sessions.b}`
        const bare = await s.herdrA("machine", "add", "bare-host", "--label", "bare", "--remote-session", "x")
        await writeEvidence(path.join(evidence, "M7-bare-add.txt"), `${bare.code}\n${bare.stdout}${bare.stderr}`)
        expect(bare.code !== 0, `herdr machine add against a host without herdr: ${bare.stdout}${bare.stderr}`)
        expect((await s.profiles()).length === 0, `a failed herdr machine add saved a machine`)

        await s.serve("b")
        expect(
          (await s.serverB("plain")).capabilities?.detached_server_daemon === false,
          "a plain herdr server is its own session leader",
        )
        const refused = await s.okA(["machine", "add", "mb", "b-host"])
        await writeEvidence(path.join(evidence, "M7-machine-add-refused.txt"), refused)
        expect(
          refused.includes(`herdr here could not add ${label}`) &&
            refused.includes("restart that session on mb once no agent runs there"),
          `machine add against B's plain herdr server: ${refused}`,
        )
        expect((await s.profiles()).length === 0, "herdr saved B's plain herdr server")
        await s.stopB()

        const listed = JSON.parse(await s.okA(["machine", "ls"])) as Array<MachineView>
        await writeEvidence(path.join(evidence, "M7-machine-ls-added.json"), JSON.stringify(listed, null, 2))
        const saved = await s.profiles()
        expect(
          saved.length === 1 && saved[0]!.label === label && saved[0]!.session === s.sessions.b,
          `A's herdr machines: ${JSON.stringify(saved)}`,
        )
        const machines = JSON.parse(await s.okA(["machine", "ls"])) as Array<MachineView>
        const herdr = machines[0]?.runtimes?.find((r) => r.kind === "herdr")
        expect(herdr?.here.visible === true && herdr.here.as === label, `machine ls: ${JSON.stringify(machines)}`)

        const printed = (
          JSON.parse(
            await w.okViaEntry(["run", "--machine", "mb", "pi", "--", ask("hseven")], { env: s.aEnv, asIs: true }),
          ) as { id: string }
        ).id
        const id = printed.slice(3)
        const bRow = (JSON.parse(await s.okB(["ls"])) as { sessions: Array<Listed> }).sessions.find((r) =>
          id.startsWith(r.id.slice(0, 8)),
        )
        expect(bRow?.runtime === "herdr", `B's row: ${JSON.stringify(bRow)}`)
        expect(bRow?.agent === "general", `B's row ran as ${bRow?.agent}, not the default general`)
        const unknown = await w.viaEntry(["run", "--machine", "mb", "--agent", "nosuch", "pi", "--", ask("hnone")], {
          env: s.aEnv,
          asIs: true,
        })
        expect(unknown.code !== 0 && unknown.stderr.includes("nosuch"), `unknown agent on B: ${unknown.stderr}`)
        const coordinator = (
          JSON.parse(
            await w.okViaEntry(["run", "--machine", "mb", "--agent", "coordinator", "pi", "--", ask("hcoord")], {
              env: s.aEnv,
              asIs: true,
            }),
          ) as { id: string }
        ).id
        const onB = (JSON.parse(await s.okB(["ls"])) as { sessions: Array<Listed> }).sessions
        expect(
          onB.find((r) => coordinator.slice(3).startsWith(r.id.slice(0, 8)))?.agent === "coordinator",
          `B's rows: ${JSON.stringify(onB.map((r) => [r.id, r.agent]))}`,
        )
        expect(onB.length === 2, `the refused run left a session on B: ${onB.length}`)
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
        await until("B saw the typed execution", () => s!.subs.asked("hstep"), 120_000)
        await until(
          "B recorded a typed execution",
          () =>
            (s!.bDb<{ n: number }>(
              "SELECT count(*) AS n FROM execution WHERE session_id = ? AND typed IS NOT NULL",
              bRow!.id,
            )?.n ?? 0) === 1,
          60_000,
        )
        await until("the typed execution's notice", () => s!.notices(printed.slice(0, 11), "hstep") === 1, 120_000)

        const removedInHerdr = await s.herdrA("machine", "remove", saved[0]!.id)
        expect(removedInHerdr.code === 0, `herdr machine remove: ${removedInHerdr.stderr}`)
        const repaired = await shown()
        expect(pattern.test(repaired?.address?.id ?? ""), `ls after herdr machine remove: ${JSON.stringify(repaired)}`)
        expect(
          (await s.profiles()).some((p) => p.label === label && p.session === s!.sessions.b),
          "the profile was not added back",
        )

        const kept = (await s.profiles()).map((p) => p.id)
        await s.stopB()
        const again = (
          JSON.parse(
            await w.okViaEntry(["run", "--machine", "mb", "pi", "--", ask("hnine")], { env: s.aEnv, asIs: true }),
          ) as { id: string }
        ).id
        await until(
          "A's row of the agent after B's herdr session restarted has its terminal",
          async () => {
            const row = (JSON.parse(await s!.okA(["ls"])) as { sessions: Array<Listed> }).sessions.find((r) =>
              r.id.startsWith(again.slice(0, 11)),
            )
            return new RegExp(`^${s!.sessions.b}/w\\d+:p\\d+/s-[0-9a-f]+@${label}$`).test(row?.address?.id ?? "")
          },
          60_000,
        )
        expect(
          (await s.serverB("restarted")).capabilities?.detached_server_daemon === true,
          "the herdr session B's vibestd started again is not its own session leader",
        )
        expect(
          JSON.stringify((await s.profiles()).map((p) => p.id)) === JSON.stringify(kept),
          "A's saved herdr machine changed when B's session restarted",
        )
        const bAgain = (JSON.parse(await s.okB(["ls"])) as { sessions: Array<Listed> }).sessions.find((r) =>
          again.slice(3).startsWith(r.id.slice(0, 8)),
        )
        const reached = await s.herdrA("--machine", label, "agent", "get", agentName(bAgain!.id))
        await writeEvidence(
          path.join(evidence, "M7-agent-get-restarted.txt"),
          `${reached.code}\n${reached.stdout}${reached.stderr}`,
        )
        expect(reached.code === 0, `herdr --machine agent get after B's restart: ${reached.stdout}${reached.stderr}`)
        await until("the notice after B's restart", () => s!.notices(again.slice(0, 11), "hnine") === 1, 120_000)

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
