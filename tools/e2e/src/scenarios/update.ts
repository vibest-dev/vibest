import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"

import type { Check } from "../check.ts"
import { alive, buildVersion, checkout, compiled, expect, harnesses, method, until, type World } from "../world.ts"

const userVersion = (w: World, v?: number) => {
  const db = new Database(path.join(w.vibestHome, "vibest.db"))
  try {
    if (v !== undefined) db.run(`PRAGMA user_version = ${v}`)
    return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
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

const out = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`.replace(/\r/g, "")

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
        schema = userVersion(w)
        userVersion(w, schema + 1)

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
          fresh.code === 0 && Array.isArray(JSON.parse(fresh.stdout)),
          `the updated vibest on an empty database: ${out(fresh)}`,
        )
      } finally {
        await server.stop(true)
        await w.stopDaemon()
        await putMovedDatabaseBack(w)
        if (schema !== undefined) userVersion(w, schema)
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
      const schema = userVersion(w)
      userVersion(w, schema + 1)
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
        userVersion(w, schema)
        const replaced = await w.tty(["daemon", "restart"], "y\n", { timeoutMs: 120_000 })
        expect(replaced.code === 0, `daemon restart once the database fits exited ${replaced.code}: ${out(replaced)}`)
        await until("a new vibestd", async () => {
          const pid = await w.daemonPid()
          return pid !== undefined && pid !== before
        })
        expect(!alive(before!), `old vibestd ${before} still alive`)
        await w.ok(["ls"])
      } finally {
        if (userVersion(w) !== schema) userVersion(w, schema)
        await w.stopDaemon()
      }
    },
  },
]

export default checks
