import { Database } from "bun:sqlite"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const checkout = path.resolve(import.meta.dirname, "../../..")

export const method = (process.env.VIBEST_E2E_METHOD ?? "build") as "build" | "npm" | "curl"
const install = process.env.VIBEST_E2E_INSTALL ?? ""
const target = () => {
  if (method === "npm") {
    const modules = path.join(install, "node_modules")
    return {
      binary: path.join(modules, ".bin/vibest"),
      compiled: path.join(modules, "@vibest", `cli-${process.platform}-${process.arch}`, "bin/vibest"),
      harnesses: path.join(modules, "@vibest/cli/harnesses"),
    }
  }
  if (method === "curl") {
    const version = path.join(
      install,
      "share/versions",
      fs.readFileSync(path.join(install, "share/current"), "utf8").trim(),
    )
    return {
      binary: path.join(install, "bin/vibest"),
      compiled: path.join(version, "bin/vibest"),
      harnesses: path.join(version, "harnesses"),
    }
  }
  const compiled = path.join(checkout, "apps/vibest-herdr/dist/vibest")
  return { binary: compiled, compiled, harnesses: path.join(checkout, "apps/vibest-herdr/harnesses") }
}
export const { binary, compiled, harnesses } = target()

export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export class Skip extends Error {}

export const fail = (message: string): never => {
  throw new Error(message)
}

export const expect = (ok: boolean, message: string) => {
  if (!ok) fail(message)
}

export class World {
  readonly home = os.homedir()
  readonly vibestHome: string
  readonly config: { readonly pi: string; readonly claude: string; readonly cursor: string }
  readonly repository: string
  readonly origin: string
  readonly log: Array<{ readonly argv: ReadonlyArray<string>; readonly cwd: string; readonly result: Ran }> = []
  private readonly started: Array<ReturnType<typeof Bun.spawn>> = []
  readonly herdrSession: string

  private constructor(readonly root: string) {
    this.vibestHome = path.join(root, "vibest")
    this.herdrSession = path.basename(root)
    this.config = {
      pi: path.join(root, "pi-agent"),
      claude: path.join(root, "claude"),
      cursor: path.join(root, "cursor"),
    }
    this.repository = path.join(root, "shop")
    this.origin = path.join(root, "shop-origin.git")
  }

  static async create(): Promise<World> {
    const tmpShortEnoughForMacosSocketPath = process.platform === "darwin" ? "/tmp" : os.tmpdir()
    const root = await fsPromises.mkdtemp(path.join(tmpShortEnoughForMacosSocketPath, "vbe-"))
    await fsPromises.chmod(root, 0o700)
    const w = new World(root)
    for (const dir of [w.vibestHome, ...Object.values(w.config), path.join(root, "tmp")])
      await fsPromises.mkdir(dir, { mode: 0o700 })
    await w.sh(root, ["git", "init", "-q", "--bare", w.origin])
    await w.sh(root, ["git", "init", "-q", "-b", "main", w.repository])
    await fsPromises.writeFile(path.join(w.repository, "README.md"), "# shop\n")
    await w.sh(w.repository, ["git", "add", "."])
    await w.sh(w.repository, ["git", "commit", "-q", "-m", "init"])
    await w.sh(w.repository, ["git", "remote", "add", "origin", w.origin])
    await w.sh(w.repository, ["git", "push", "-q", "-u", "origin", "main"])
    return w
  }

  env(extra: Record<string, string | undefined> = {}): Record<string, string> {
    const env: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(process.env))
      if (!k.startsWith("VIBEST_") && !k.startsWith("HERDR_") && k !== "PI_PACKAGE_DIR") env[k] = v
    Object.assign(
      env,
      {
        VIBEST_HOME: this.vibestHome,
        PI_CODING_AGENT_DIR: this.config.pi,
        CLAUDE_CONFIG_DIR: this.config.claude,
        CURSOR_CONFIG_DIR: this.config.cursor,
        PATH: [path.dirname(binary), path.join(this.home, ".local", "bin"), process.env.PATH].join(":"),
        TMPDIR: path.join(this.root, "tmp"),
        GIT_AUTHOR_NAME: "e2e",
        GIT_AUTHOR_EMAIL: "e2e@example.invalid",
        GIT_COMMITTER_NAME: "e2e",
        GIT_COMMITTER_EMAIL: "e2e@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      extra,
    )
    return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined))
  }

  async run(
    cwd: string,
    argv: ReadonlyArray<string>,
    options: { env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number } = {},
  ): Promise<Ran> {
    const p = Bun.spawn([...argv], {
      cwd,
      env: this.env(options.env),
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMs ?? 60_000,
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    const result = { code, stdout, stderr }
    this.log.push({ argv: argv.map(redact), cwd, result })
    return result
  }

  withSession(args: ReadonlyArray<string>): ReadonlyArray<string> {
    if (args.includes("--session")) return args
    if (args[0] === "run") return ["run", "--session", this.herdrSession, ...args.slice(1)]
    if (args.length === 0 || (args[0]!.startsWith("-") && args[0] !== "--version" && args[0] !== "--help"))
      return ["--session", this.herdrSession, ...args]
    return args
  }

  vibest(
    args: ReadonlyArray<string>,
    options: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number } = {},
  ) {
    return this.run(options.cwd ?? this.repository, [binary, ...this.withSession(args)], options)
  }

  foreignTerminals(): ReadonlyArray<string> {
    const file = path.join(this.vibestHome, "vibest.db")
    if (!fs.existsSync(file)) return []
    const db = new Database(file, { readonly: true })
    try {
      const rows = db.query(`SELECT id, runtime FROM ${SESSIONS} s`).all() as Array<{
        id: string
        runtime: string | null
      }>
      return rows.flatMap((r) => {
        const terminal = (JSON.parse(r.runtime ?? "{}") as { id?: string }).id ?? ""
        const session = terminal.split("/")[0] ?? ""
        return session === "" || session === this.herdrSession || session.startsWith(`${this.herdrSession}-`)
          ? []
          : [`${r.id} at ${terminal}`]
      })
    } finally {
      db.close()
    }
  }

  tty(
    args: ReadonlyArray<string>,
    answers: string,
    options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
  ) {
    const pty = ["python3", "-I", path.join(import.meta.dirname, "terminal.py"), binary, ...this.withSession(args)]
    return this.run(options.cwd ?? this.repository, pty, { ...options, stdin: answers })
  }

  async ok(args: ReadonlyArray<string>, options: Parameters<World["vibest"]>[1] = {}): Promise<string> {
    const r = await this.vibest(args, options)
    expect(r.code === 0, `vibest ${args.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`)
    return r.stdout
  }

  async json<A = unknown>(args: ReadonlyArray<string>, options: Parameters<World["vibest"]>[1] = {}): Promise<A> {
    return JSON.parse(await this.ok(args, options)) as A
  }

  private async sh(cwd: string, argv: ReadonlyArray<string>) {
    const r = await this.run(cwd, argv)
    expect(r.code === 0, `${argv.join(" ")}: ${r.stderr}`)
  }

  spawn(argv: ReadonlyArray<string>, log: string) {
    const p = Bun.spawn([...argv], { cwd: this.repository, env: this.env(), stdout: "ignore", stderr: Bun.file(log) })
    this.started.push(p)
    return p
  }

  async daemonPid(): Promise<number | undefined> {
    const text = await fsPromises.readFile(path.join(this.vibestHome, "vibestd.pid"), "utf8").catch(() => "")
    try {
      const pid = (JSON.parse(text) as { pid?: unknown }).pid
      return typeof pid === "number" && pid > 0 ? pid : undefined
    } catch {
      return undefined
    }
  }

  async stopDaemon() {
    const pid = await this.daemonPid()
    if (pid !== undefined && alive(pid)) {
      process.kill(pid, "SIGTERM")
      for (const deadline = Date.now() + 10_000; alive(pid) && Date.now() < deadline;) await Bun.sleep(100)
      if (alive(pid)) process.kill(pid, "SIGKILL")
    }
  }

  async close() {
    await this.stopDaemon()
    const vibestStartedThisRunsHerdrSession = await fsPromises
      .stat(path.join(this.home, ".config", "herdr", "sessions", this.herdrSession))
      .then(
        () => true,
        () => false,
      )
    if (vibestStartedThisRunsHerdrSession) {
      await this.run(this.root, ["herdr", "session", "stop", this.herdrSession])
      await this.run(this.root, ["herdr", "session", "delete", this.herdrSession])
    }
    for (const p of this.started) if (p.exitCode === null) p.kill()
    await Promise.all(this.started.map((p) => p.exited))
  }
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const SESSIONS = `(SELECT s.id, s.project_id, s.role AS agent_type, s.directory, s.created_at, s.ended_at,
    json_extract(p.data, '$.harness') AS harness, json_extract(p.data, '$.provider') AS provider,
    CASE WHEN p.id IS NULL THEN NULL ELSE json_object('kind', json_extract(p.data, '$.runtime'),
      'machine', json_extract(p.data, '$.machine'), 'id', json_extract(p.data, '$.terminal')) END AS runtime,
    coalesce((SELECT json_extract(e.data, '$.conversation') FROM event e WHERE e.process_id = p.id
      AND e.type IN ('process.ready', 'process.conversation') AND json_extract(e.data, '$.conversation') IS NOT NULL
      ORDER BY e.id DESC LIMIT 1), json_extract(p.data, '$.resume')) AS harness_session_id,
    coalesce((SELECT json_extract(e.data, '$.pid') FROM event e WHERE e.process_id = p.id AND e.type = 'process.ready'
      AND json_extract(e.data, '$.pid') IS NOT NULL ORDER BY e.id DESC LIMIT 1), json_extract(p.data, '$.pid')) AS pid,
    (SELECT json_extract(e.data, '$.integration.version') FROM event e WHERE e.process_id = p.id
      AND e.type = 'process.ready' AND json_extract(e.data, '$.integration') IS NOT NULL
      ORDER BY e.id DESC LIMIT 1) AS version,
    (SELECT e.at FROM event e WHERE e.process_id = p.id AND e.type = 'process.end') AS exited_at
  FROM session s LEFT JOIN event p ON p.id = (SELECT max(id) FROM event WHERE session_id = s.id AND type = 'process.start'))`

export const TURNS = `(SELECT t.id, t.session_id, coalesce(json_extract(te.data, '$.status'), 'working') AS status
  FROM event t LEFT JOIN event te ON te.turn_id = t.id AND te.type = 'turn.end' WHERE t.type = 'turn.start')`

export const row = <A>(w: World, sql: string, ...args: Array<string | number>) => {
  const db = new Database(path.join(w.vibestHome, "vibest.db"), { readonly: true })
  try {
    return (db.query(sql).get(...args) ?? undefined) as A | undefined
  } finally {
    db.close()
  }
}

export const until = async (what: string, ok: () => Promise<boolean> | boolean, timeoutMs = 10_000) => {
  for (const deadline = Date.now() + timeoutMs; !(await ok()); await Bun.sleep(100))
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`)
}

const agentEnv = (process.env.VIBEST_E2E_ENV ?? "")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))

export const redact = (text: string) =>
  agentEnv.reduce((t, pair) => {
    const value = pair.slice(pair.indexOf("=") + 1)
    return value === "" ? t : t.split(value).join("<redacted>")
  }, text)

export const agentModel = (): ReadonlyArray<string> => {
  const provider = process.env.VIBEST_E2E_PROVIDER
  return [
    ...(provider ? ["--provider", provider] : []),
    "--model",
    process.env.VIBEST_E2E_MODEL || "haiku",
    ...agentEnv.flatMap((pair) => ["--env", pair]),
  ]
}

export const agentName = (id: string) => `s-${id.replaceAll("-", "").slice(0, 30)}`

export const herdr = (socket: string, method: string, params: object) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = crypto.randomUUID()
    let buffer = ""
    Bun.connect({
      unix: socket,
      socket: {
        open: (s) => void s.write(`${JSON.stringify({ id, method, params })}\n`),
        data: (s, chunk) => {
          buffer += Buffer.from(chunk).toString("utf8")
          for (const line of buffer.split("\n").slice(0, -1)) {
            const m = JSON.parse(line) as { id?: string; result?: Record<string, unknown>; error?: unknown }
            if (m.id !== id) continue
            s.end()
            if (m.error) reject(new Error(`herdr ${method}: ${JSON.stringify(m.error)}`))
            else resolve(m.result ?? {})
          }
          buffer = buffer.slice(buffer.lastIndexOf("\n") + 1)
        },
        error: (_s, e) => reject(e),
      },
    }).catch(reject)
  })

export const transcript = async (w: World, cwd: string) => {
  const dir = path.join(w.home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  const files = (await fsPromises.readdir(dir).catch(() => [] as Array<string>)).filter((f) => f.endsWith(".jsonl"))
  const entries: Array<{ type?: string; raw: string; text: string }> = []
  for (const f of files)
    for (const raw of (await fsPromises.readFile(path.join(dir, f), "utf8")).split("\n").filter(Boolean)) {
      const e = JSON.parse(raw) as { type?: string; message?: { content?: unknown } }
      const content = e.message?.content
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((c: { text?: string }) => c.text ?? "").join("")
            : ""
      entries.push({ type: e.type, raw, text })
    }
  return entries
}

export const onPath = (bin: string) => Bun.which(bin) !== null

export const knownSessions = async (
  w: World,
  sessions: Record<string, string>,
  directory = w.repository,
  harness = "claude",
) => {
  await w.ok(["ls"])
  const db = new Database(path.join(w.vibestHome, "vibest.db"))
  try {
    const project = crypto.randomUUID()
    db.run("INSERT INTO project (id) VALUES (?)", [project])
    for (const [id, agent] of Object.entries(sessions)) {
      const at = Date.now()
      db.run(
        "INSERT INTO session (id, project_id, role, name, machine, directory, created_at) VALUES (?, ?, ?, '', 'local', ?, ?)",
        [id, project, agent, directory, at],
      )
      db.run("INSERT INTO event (at, session_id, type, data) VALUES (?, ?, 'process.start', ?)", [
        at,
        id,
        JSON.stringify({ harness, runtime: "", machine: "local", terminal: "" }),
      ])
    }
    return project
  } finally {
    db.close()
  }
}
