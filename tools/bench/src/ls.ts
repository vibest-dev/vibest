import fs from "node:fs/promises"
import path from "node:path"

import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Bus } from "@vibest/core/bus"
import { Db, SQL_NAMES } from "@vibest/core/db"
import { SessionLive } from "@vibest/core/session/live"
import { Effect, Layer } from "effect"

const checkout = path.resolve(import.meta.dirname, "../../..")
const binary = path.join(checkout, "packages/cli/dist/vibest")
const sizes = [200, 1000]
const runs = 20
const idleMs = 15_000
const cpuMs = 60_000
const BENCH_RUNTIME = "bench"

const quantile = (xs: ReadonlyArray<number>, p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  const rank = (p / 100) * (s.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return s[lo]! * (1 - (rank - lo)) + s[hi]! * (rank - lo)
}

const clock = (text: string) => {
  const parts = text.split(":").map(Number)
  if (parts.some((n) => Number.isNaN(n))) throw new Error(`cpu time ${text}`)
  return parts.reduce((sum, n) => sum * 60 + n, 0)
}

const cpuSeconds = (pid: number) => {
  const out = new TextDecoder().decode(Bun.spawnSync({ cmd: ["ps", "-p", String(pid), "-o", "utime=,stime="] }).stdout)
  const parts = out.trim().split(/\s+/)
  if (parts.length < 2) throw new Error(`ps ${pid}: ${JSON.stringify(out)}`)
  return clock(parts[0]!) + clock(parts[1]!)
}

const envFor = (home: string) => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("VIBEST_") || key.startsWith("HERDR_")) continue
    env[key] = value
  }
  env.VIBEST_HOME = home
  env.GIT_CONFIG_GLOBAL = "/dev/null"
  return env
}

const run = async (cwd: string, argv: ReadonlyArray<string>, env: Record<string, string>) => {
  const p = Bun.spawn([...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, stdout, stderr }
}

const stop = async (home: string) => {
  const text = await fs.readFile(path.join(home, "vibestd.pid"), "utf8").catch(() => "")
  const pid = text === "" ? undefined : (JSON.parse(text) as { pid?: unknown }).pid
  if (typeof pid !== "number" || pid <= 0) return
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(100)) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}

const seed = (file: string, directory: string, n: number) =>
  Effect.gen(function* () {
    const db = yield* Db
    const project = yield* db.createProject(directory, [])
    const now = Date.now()
    for (let i = 0; i < n; i++) {
      const inserted = yield* db.insertSession(
        {
          id: `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
          agent: "general",
          name: `n${i}`,
          harnessId: "pi",
          provider: null,
          model: null,
          harnessSessionId: null,
          runtime: BENCH_RUNTIME,
          address: { machine: "bench", id: `b${i}` },
          status: "unknown",
          startedAt: now,
          exitedAt: null,
          executionState: "none",
          executionPromptedAt: 0,
          metadata: {},
          createdAt: now,
          lastActive: now,
        },
        project,
        undefined,
        "",
        "seed",
      )
      if (!inserted) return yield* Effect.die(`session ${i} was not inserted`)
    }
  }).pipe(
    Effect.provide(
      Db.layer.pipe(
        Layer.provide(SqliteClient.layer({ filename: file, disableWAL: true, ...SQL_NAMES })),
        Layer.provide(Bus.layer),
        Layer.provide(SessionLive.layer),
      ),
    ),
    Effect.scoped,
  )

const time = async (cwd: string, args: ReadonlyArray<string>, env: Record<string, string>, n: number) => {
  const samples: Array<number> = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    const r = await run(cwd, [binary, ...args], env)
    const ms = performance.now() - started
    if (r.code !== 0)
      throw new Error(`vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
    const rows = JSON.parse(r.stdout) as Array<unknown>
    if (i === 0 && rows.length !== n) throw new Error(`vibest ${args.join(" ")} listed ${rows.length}, want ${n}`)
    samples.push(ms)
  }
  return { median: quantile(samples, 50), p95: quantile(samples, 95) }
}

const one = async (n: number) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join("/tmp", "vbl-")))
  const home = path.join(root, "vibest")
  const repo = path.join(root, "repo")
  await fs.mkdir(home, { mode: 0o700 })
  await fs.mkdir(repo)
  const env = envFor(home)
  const git = {
    ...env,
    GIT_AUTHOR_NAME: "bench",
    GIT_AUTHOR_EMAIL: "bench@example.invalid",
    GIT_COMMITTER_NAME: "bench",
    GIT_COMMITTER_EMAIL: "bench@example.invalid",
  }
  try {
    for (const argv of [
      ["git", "init", "-q", "-b", "main", repo],
      ["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"],
    ]) {
      const r = await run(root, argv, git)
      if (r.code !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr}`)
    }
    const directory = await fs.realpath(repo)
    await Effect.runPromise(seed(path.join(home, "vibest.db"), directory, n))
    const started = await run(directory, [binary, "daemon"], env)
    if (started.code !== 0) throw new Error(`vibest daemon exited ${started.code}: ${started.stderr || started.stdout}`)
    await Bun.sleep(idleMs)
    const ls = await time(directory, ["ls"], env, n)
    const pid = (JSON.parse(await fs.readFile(path.join(home, "vibestd.pid"), "utf8")) as { pid: number }).pid
    const before = cpuSeconds(pid)
    await Bun.sleep(cpuMs)
    const cpu = cpuSeconds(pid) - before
    const line = [
      `n=${n}`,
      `ls_median_ms=${ls.median.toFixed(1)}`,
      `ls_p95_ms=${ls.p95.toFixed(1)}`,
      `idle_cpu_s=${cpu.toFixed(3)}`,
    ].join(" ")
    console.log(line)
    return line
  } finally {
    await stop(home)
    await fs.rm(root, { recursive: true, force: true })
  }
}

if (!(await Bun.file(binary).exists())) {
  console.error(`no ${binary}; run pnpm build first`)
  process.exit(1)
}
for (const n of sizes) await one(n)
