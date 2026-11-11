import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, holdsSlowMessageModel, piDir } from "../fake-model.ts"
import {
  alive,
  buildVersion,
  checkout,
  compiled,
  expect,
  harnesses,
  method,
  readDb,
  SESSIONS,
  Skip,
  until,
  type World,
} from "../world.ts"
import { dropHerdrSession, project } from "./inbox.ts"

const applicationId = (w: World, v?: number) => {
  const db = new Database(path.join(w.vibestHome, "vibest.db"))
  try {
    if (v !== undefined) db.run(`PRAGMA application_id = ${v}`)
    return db.query<{ application_id: number }, []>("PRAGMA application_id").get()!.application_id
  } finally {
    db.close()
  }
}

const DATABASE_FILES = ["vibest.db", "vibest.db-wal", "vibest.db-shm"]

const putMovedDatabaseBack = async (w: World) => {
  const file = (f: string) => path.join(w.vibestHome, f)
  if (
    !(await fs.stat(file("vibest.db.old")).then(
      () => true,
      () => false,
    ))
  )
    return
  for (const f of DATABASE_FILES) await fs.rm(file(f), { force: true })
  for (const f of DATABASE_FILES) await fs.rename(file(`${f}.old`), file(f)).catch(() => undefined)
}

const swapOnce = (bytes: Buffer, from: string, to: string) => {
  const at = bytes.indexOf(from)
  expect(at >= 0 && bytes.indexOf(from, at + 1) < 0 && from.length === to.length, `cannot swap ${from} for ${to}`)
  bytes.write(to, at)
}

const protocolLine = (protocol: number, width: number) => `PROTOCOL = ${String(protocol).padStart(width)}`
const olderProtocol = (bytes: Buffer, protocol: number) =>
  swapOnce(bytes, protocolLine(protocol, 0), protocolLine(protocol - 1, String(protocol).length))

const olderVibest = async (w: World, share: string, version: string, protocol: number) => {
  const dir = path.join(share, "versions", version)
  const bin = path.join(dir, "bin", "vibest")
  await fs.mkdir(path.dirname(bin), { recursive: true })
  const bytes = Buffer.from(await fs.readFile(compiled))
  olderProtocol(bytes, protocol)
  swapOnce(bytes, `version: "${buildVersion}"`, `version: "${version}"`)
  await fs.writeFile(bin, bytes, { mode: 0o755 })
  if (process.platform === "darwin") {
    const signed = await w.run(dir, ["codesign", "--force", "-s", "-", bin])
    expect(signed.code === 0, `codesign: ${out(signed)}`)
  }
  await fs.cp(harnesses, path.join(dir, "harnesses"), { recursive: true })
  const extension = path.join(dir, "harnesses", "pi", "extension.mjs")
  const source = Buffer.from(await fs.readFile(extension))
  olderProtocol(source, protocol)
  const older = source.toString().replace("var VERSION = package_default.version;", `var VERSION = "${version}";`)
  expect(older !== source.toString(), `${extension}: its version was not found`)
  await fs.writeFile(extension, older)
  return bin
}

const out = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`.replace(/\r/g, "")

const buildProtocol = async () =>
  Number(/PROTOCOL = (\d+)/.exec(await fs.readFile(path.join(harnesses, "pi", "extension.mjs"), "utf8"))![1])

const olderAgents = async (
  w: World,
  tag: string,
  link: string,
  env: Record<string, string>,
  modelUrl: string,
  version: string,
) => {
  const session = `${w.herdrSession}-${tag}`
  const repo = await project(w, tag)
  const agentDir = await piDir(w, `pi-${tag}`, modelUrl)
  const vibest = (args: ReadonlyArray<string>, timeoutMs = 120_000) => w.run(repo, [link, ...args], { env, timeoutMs })
  const read = (where: string, arg: string) => {
    const db = readDb(path.join(w.vibestHome, "vibest.db"))
    try {
      return db
        .query<{ id: string; harness_session_id: string | null; pid: number | null; version: string | null }, [string]>(
          `SELECT s.id, s.harness_session_id, s.pid, s.version FROM ${SESSIONS} s WHERE ${where}`,
        )
        .get(arg)
    } finally {
      db.close()
    }
  }
  const main = () =>
    read(`s.agent_type = 'main' AND s.ended_at IS NULL AND s.directory LIKE ?`, `%/${path.basename(repo)}`)
  const reported = (row: ReturnType<typeof main>, v: string) =>
    row?.version === v && row.harness_session_id !== null && row.pid !== null

  await w.stopDaemon()
  const started = await vibest(["daemon"])
  expect(started.code === 0, `the older vibest daemon exited ${started.code}: ${out(started)}`)
  await w.startEntry({
    harness: "pi",
    session,
    cwd: repo,
    env: { PI_CODING_AGENT_DIR: agentDir },
    processEnv: env,
    bin: link,
    timeoutMs: 60_000,
  })
  const ran = await w.viaEntry(
    ["run", "--runtime", "herdr", "pi", "--session", session, "--env", `PI_CODING_AGENT_DIR=${agentDir}`, ask("zero")],
    { cwd: repo, env, bin: link, timeoutMs: 120_000 },
  )
  expect(ran.code === 0, `vibest run exited ${ran.code}: ${out(ran)}`)
  const sub = (JSON.parse(ran.stdout) as { id: string }).id
  await until(
    "both agents report the older integration and their conversations",
    () => reported(main(), version) && reported(read("s.id = ?", sub), version),
    120_000,
  )
  const before = { main: main()!, sub: read("s.id = ?", sub)! }
  const daemonBefore = await w.daemonPid()

  const restartedOnBuild = async () => {
    const daemonAfter = await w.daemonPid()
    expect(daemonAfter !== undefined && daemonAfter !== daemonBefore, `vibestd ${daemonBefore} -> ${daemonAfter}`)
    const ps = (field: string, pid: number) =>
      Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)])
        .stdout.toString()
        .trim()
    const parent = Number(ps("ppid", daemonAfter!))
    expect(
      parent === 1 || !ps("command", parent).includes("vibest"),
      `vibestd ${daemonAfter} is a child of ${parent} (${ps("command", parent)}), which may never reap it`,
    )
    for (const [name, row, now] of [
      ["subagent", before.sub, () => read("s.id = ?", sub)],
      ["entry session", before.main, main],
    ] as const) {
      await until(
        `the ${name} restarted on this integration`,
        () => reported(now(), buildVersion) && now()!.pid !== row.pid,
        120_000,
      ).catch(async (e: Error) => {
        const log = await fs.readFile(path.join(w.vibestHome, "vibestd.log"), "utf8").catch(() => "")
        throw new Error(`${e.message}; row ${JSON.stringify(now())}\nvibestd.log:\n${log.slice(-4000)}`)
      })
      expect(now()?.id === row.id, `the ${name}'s session changed: ${row.id} -> ${now()?.id}`)
      expect(
        now()?.harness_session_id === row.harness_session_id,
        `the ${name}'s conversation changed: ${row.harness_session_id} -> ${now()?.harness_session_id}`,
      )
      expect(!alive(row.pid!), `the ${name}'s old harness ${row.pid} still runs`)
    }
  }
  return { repo, vibest, before, restartedOnBuild }
}

const checks: ReadonlyArray<Check> = [
  {
    id: "U1",
    title:
      "update reads the latest version where vibest was installed from (npm's registry or the GitHub release) and installs nothing when it is this version; a build installs nothing",
    run: async (w) => {
      await w.stopDaemon()
      const r = await w.vibest(["update"], { timeoutMs: 60_000 })
      const said = `exit ${r.code}: ${r.stdout}${r.stderr}`
      if (method === "build")
        expect(r.code === 0 && /was not installed by npm or install\.sh; nothing to install/.test(r.stdout), said)
      else expect(r.code === 0 && r.stdout.includes(`vibest is already up to date (v${buildVersion})`), said)
      const version = await w.ok(["--version"])
      expect(version.trim() === `vibest v${buildVersion}`, `vibest --version after update: ${version}`)
    },
  },
  {
    id: "U9",
    title:
      "vibest update to a version that cannot open the database installs nothing and leaves the old vibestd working; the way out its message names (stop vibestd, move the database aside) then lets the update through",
    run: async (w) => {
      await w.stopDaemon()
      const version = (await w.ok(["--version"])).trim().replace(/^vibest v/, "")
      await fs.mkdir(path.join(w.root, "u9"), { recursive: true })
      const root = await fs.realpath(path.join(w.root, "u9"))
      const share = path.join(root, "share")
      const bin = path.join(root, "bin")
      const old = path.join(share, "versions", version, "bin", "vibest")
      await fs.mkdir(path.dirname(old), { recursive: true })
      await fs.copyFile(compiled, old)
      await fs.chmod(old, 0o755)
      await fs.cp(harnesses, path.join(share, "versions", version, "harnesses"), { recursive: true })
      await fs.mkdir(bin, { recursive: true })
      await fs.symlink(old, path.join(bin, "vibest"))
      await fs.writeFile(path.join(share, "bin"), `${bin}\n`)
      await fs.writeFile(path.join(share, "current"), `${version}\n`)
      const release = path.join(root, "release-999")
      await fs.mkdir(path.join(release, "bin"), { recursive: true })
      await fs.writeFile(
        path.join(release, "bin", "vibest"),
        `#!/bin/sh\n[ "$1" = --version ] && echo "vibest v999.0.0" && exit 0\nexec '${compiled}' "$@"\n`,
        { mode: 0o755 },
      )
      await fs.cp(harnesses, path.join(release, "harnesses"), { recursive: true })
      const archive = `vibest-${process.platform}-${process.arch}.tar.gz`
      const packed = await w.run(root, ["tar", "-czf", path.join(root, archive), "-C", release, "bin", "harnesses"])
      expect(packed.code === 0, `tar: ${out(packed)}`)
      const installSh = path.join(checkout, "packages", "cli", "install.sh")
      let downloads = 0
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (req) => {
          const url = new URL(req.url).pathname
          if (url === "/version") return new Response("999.0.0\n")
          if (url === "/install.sh") return new Response(Bun.file(installSh))
          if (url === `/${archive}`) {
            downloads++
            return new Response(Bun.file(path.join(root, archive)))
          }
          return new Response("not found", { status: 404 })
        },
      })
      const env = { VIBEST_DOWNLOAD_URL: `http://127.0.0.1:${server.port}`, npm_config_registry: "http://127.0.0.1:9" }
      const vibest = (args: ReadonlyArray<string>) => w.run(w.repository, [old, ...args], { env, timeoutMs: 120_000 })
      let schema: number | undefined
      try {
        const started = await vibest(["daemon"])
        expect(started.code === 0, `old vibest daemon exited ${started.code}: ${out(started)}`)
        const before = await w.daemonPid()
        expect(before !== undefined, "no vibestd pid")
        schema = applicationId(w)
        applicationId(w, schema + 1)

        const refused = await vibest(["update"])
        const said = out(refused)
        expect(refused.code !== 0, `vibest update exited 0: ${said}`)
        expect(
          /UpdateError: vibest 999\.0\.0 cannot take over: SchemaMismatch: .*vibest\.db is not this vibest's schema/.test(
            said,
          ) &&
            said.includes(`Nothing was installed: vibest ${version} stays`) &&
            /vibestd \S+ \(pid \d+, .*\) was not stopped and keeps working/.test(said) &&
            said.includes(`kill -TERM ${before}`) &&
            said.includes("then run: vibest update") &&
            said.includes("the sessions, results and queued messages it holds are lost"),
          `unexpected: ${said}`,
        )
        expect(!said.includes("migration script"), `it names a migration script: ${said}`)
        expect(downloads === 1, `the release was downloaded ${downloads} times to try it`)
        expect(
          (await fs.readFile(path.join(share, "current"), "utf8")).trim() === version,
          "install.sh recorded another current version",
        )
        expect(
          !(await fs.stat(path.join(share, "versions", "999.0.0")).then(
            () => true,
            () => false,
          )),
          "999.0.0 was installed",
        )
        expect((await fs.readlink(path.join(bin, "vibest"))) === old, "the vibest link changed")
        expect((await w.daemonPid()) === before && alive(before!), `vibestd ${before} -> ${await w.daemonPid()}`)
        const listed = await vibest(["ls"])
        expect(listed.code === 0, `vibest ls after the refused update: ${out(listed)}`)

        process.kill(before!, "SIGTERM")
        await until(
          "vibest status shows vibestd not running",
          async () =>
            (JSON.parse((await vibest(["status"])).stdout) as { daemon: { status: string } }).daemon.status ===
            "not running",
          15_000,
        )
        const moveAside = /(for f in .*?; done)/.exec(said)?.[1]
        expect(moveAside !== undefined, `no move-aside command in: ${said}`)
        const moved = await w.run(w.vibestHome, ["sh", "-c", moveAside!])
        expect(
          !(await fs.stat(path.join(w.vibestHome, "vibest.db")).then(
            () => true,
            () => false,
          )),
          `the database is still there after ${moveAside}: ${out(moved)}`,
        )
        const through = await vibest(["update"])
        expect(
          through.code === 0 && out(through).includes("vibest 999.0.0 is available"),
          `vibest update after the way out exited ${through.code}: ${out(through)}`,
        )
        expect(downloads === 3, `the release was downloaded ${downloads} times; one try, then one try and one install`)
        expect(
          (await fs.readFile(path.join(share, "current"), "utf8")).trim() === "999.0.0",
          "install.sh did not record 999.0.0 as current",
        )
        expect(
          (await fs.readlink(path.join(bin, "vibest"))) === path.join(share, "versions", "999.0.0", "bin", "vibest"),
          "the vibest link does not point at 999.0.0",
        )
        const fresh = await w.run(w.repository, [path.join(bin, "vibest"), "ls"], { env })
        expect(
          fresh.code === 0 && Array.isArray(JSON.parse(fresh.stdout).sessions),
          `the updated vibest on an empty database: ${out(fresh)}`,
        )
      } finally {
        await server.stop(true)
        await w.stopDaemon()
        await putMovedDatabaseBack(w)
        if (schema !== undefined) applicationId(w, schema)
      }
    },
  },
  {
    id: "U10",
    title:
      "vibest daemon restart onto a vibest that cannot open the database stops nothing and asks nothing; the old vibestd keeps answering, and a restart once the database fits goes through",
    run: async (w) => {
      const old = path.join(w.root, "u10-old", "bin", "vibest")
      await fs.mkdir(path.dirname(old), { recursive: true })
      await fs.copyFile(compiled, old)
      await fs.chmod(old, 0o755)
      await w.stopDaemon()
      const started = await w.run(w.repository, [old, "daemon"])
      expect(started.code === 0, `old vibest daemon exited ${started.code}: ${out(started)}`)
      const before = await w.daemonPid()
      expect(before !== undefined, "no vibestd pid")
      const schema = applicationId(w)
      applicationId(w, schema + 1)
      try {
        const refused = await w.tty(["daemon", "restart"], "y\n", { timeoutMs: 120_000 })
        const said = out(refused)
        expect(refused.code !== 0, `daemon restart exited 0: ${said}`)
        expect(
          /cannot take over: SchemaMismatch: .*vibest\.db is not this vibest's schema/.test(said) &&
            /vibestd \S+ \(pid \d+, .*\) was not stopped and keeps working/.test(said) &&
            said.includes(`kill -TERM ${before}`) &&
            said.includes("then run: vibest daemon"),
          `unexpected: ${said}`,
        )
        expect(!/Replace vibestd/.test(said), `it asked to replace vibestd: ${said}`)
        expect((await w.daemonPid()) === before && alive(before!), `vibestd ${before} -> ${await w.daemonPid()}`)
        await w.ok(["ls"])
        applicationId(w, schema)
        const replaced = await w.tty(["daemon", "restart"], "y\n", { timeoutMs: 120_000 })
        expect(replaced.code === 0, `daemon restart once the database fits exited ${replaced.code}: ${out(replaced)}`)
        await until("a new vibestd", async () => {
          const pid = await w.daemonPid()
          return pid !== undefined && pid !== before
        })
        expect(!alive(before!), `old vibestd ${before} still alive`)
        await w.ok(["ls"])
      } finally {
        if (applicationId(w) !== schema) applicationId(w, schema)
        await w.stopDaemon()
      }
    },
  },
  {
    id: "U11",
    title:
      "one vibest update run by an older vibest that speaks an older protocol installs this build, hands vibestd over, and the installed vibest restarts the agents still on the old integration in place",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const protocol = await buildProtocol()
      const version = buildVersion.replace(/\d/g, "0")
      const model = holdsSlowMessageModel()
      await fs.mkdir(path.join(w.root, "u11-install"), { recursive: true })
      const root = await fs.realpath(path.join(w.root, "u11-install"))
      const share = path.join(root, "share")
      const bin = path.join(root, "bin")
      const link = path.join(bin, "vibest")
      const release = path.join(root, "release")
      const archive = `vibest-${process.platform}-${process.arch}.tar.gz`
      await fs.mkdir(path.join(release, "bin"), { recursive: true })
      await fs.copyFile(compiled, path.join(release, "bin", "vibest"))
      await fs.chmod(path.join(release, "bin", "vibest"), 0o755)
      await fs.cp(harnesses, path.join(release, "harnesses"), { recursive: true })
      const packed = await w.run(root, ["tar", "-czf", path.join(root, archive), "-C", release, "bin", "harnesses"])
      expect(packed.code === 0, `tar: ${out(packed)}`)
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (req) => {
          const url = new URL(req.url).pathname
          if (url === "/version") return new Response(`${buildVersion}\n`)
          if (url === "/install.sh") return new Response(Bun.file(path.join(checkout, "packages", "cli", "install.sh")))
          if (url === `/${archive}`) return new Response(Bun.file(path.join(root, archive)))
          return new Response("not found", { status: 404 })
        },
      })
      try {
        const old = await olderVibest(w, share, version, protocol)
        await fs.mkdir(bin, { recursive: true })
        await fs.symlink(old, link)
        await fs.writeFile(path.join(share, "bin"), `${bin}\n`)
        await fs.writeFile(path.join(share, "current"), `${version}\n`)
        const env = {
          PATH: `${bin}:${w.env().PATH}`,
          VIBEST_DOWNLOAD_URL: `http://127.0.0.1:${server.port}`,
          npm_config_registry: "http://127.0.0.1:9",
        }
        const agents = await olderAgents(w, "u11", link, env, model.url, version)

        const updated = await agents.vibest(["update", "--yes"], 300_000)
        const said = out(updated)
        expect(updated.code === 0, `vibest update exited ${updated.code}: ${said}`)
        expect(
          said.includes(`vibest ${buildVersion} is available (this is ${version})`) &&
            /vibestd: handoff\./.test(said) &&
            said.includes(`vibestd ${buildVersion} (pid`) &&
            said.includes("vibest update has finished") &&
            said.includes(agents.before.main.id.slice(0, 8)) &&
            said.includes(agents.before.sub.id.slice(0, 8)),
          `unexpected: ${said}`,
        )
        expect(!said.includes("IncompatibleDaemon"), `the older vibest talked to the new vibestd: ${said}`)
        expect(
          (await fs.readlink(link)) === path.join(share, "versions", buildVersion, "bin", "vibest"),
          `${link} does not point at ${buildVersion}`,
        )
        await agents.restartedOnBuild()
      } finally {
        model.stop()
        await server.stop(true)
        await w.stopDaemon()
        await dropHerdrSession(w, `${w.herdrSession}-u11`)
      }
    },
  },
  {
    id: "U12",
    title:
      "vibest update run by this build replaces a vibestd that an older vibest on an older protocol runs, and restarts the agents still on the old integration in place",
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const version = buildVersion.replace(/\d/g, "0")
      const model = holdsSlowMessageModel()
      await fs.mkdir(path.join(w.root, "u12-install"), { recursive: true })
      const root = await fs.realpath(path.join(w.root, "u12-install"))
      try {
        const old = await olderVibest(w, path.join(root, "share"), version, await buildProtocol())
        const env = { PATH: `${path.dirname(old)}:${w.env().PATH}` }
        const agents = await olderAgents(w, "u12", old, env, model.url, version)

        const updated = await w.vibest(["update", "--yes"], { cwd: agents.repo, timeoutMs: 300_000 })
        const said = out(updated)
        expect(updated.code === 0, `vibest update exited ${updated.code}: ${said}`)
        expect(
          /vibestd: handoff\./.test(said) &&
            said.includes(`vibestd ${buildVersion} (pid`) &&
            said.includes("vibest update has finished") &&
            said.includes(agents.before.main.id.slice(0, 8)) &&
            said.includes(agents.before.sub.id.slice(0, 8)),
          `unexpected: ${said}`,
        )
        await agents.restartedOnBuild()
      } finally {
        model.stop()
        await w.stopDaemon()
        await dropHerdrSession(w, `${w.herdrSession}-u12`)
      }
    },
  },
]

export default checks
