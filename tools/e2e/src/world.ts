import { Database } from "bun:sqlite"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { claudeShadow, cursorShadow, type Profile, userPrivateValues } from "./world/shadow.ts"
import { loginEnv, secretName } from "./world/user-env.ts"

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

export const vibestTyped = `'${binary.replaceAll("'", "'\\''")}'`

export const buildVersion = (
  JSON.parse(fs.readFileSync(path.join(checkout, "apps/vibest-herdr/package.json"), "utf8")) as { version: string }
).version

const zshKeepingHistoryInTheWorld = async (dir: string) => {
  await fsPromises.mkdir(dir, { mode: 0o700 })
  const user = (file: string) =>
    `ZDOTDIR=$__vbe_user\n[[ -r $ZDOTDIR/${file} ]] && source $ZDOTDIR/${file}\nZDOTDIR=$__vbe_zdot\n`
  const history = "HISTFILE=$__vbe_zdot/.zsh_history\n"
  await fsPromises.writeFile(
    path.join(dir, ".zshenv"),
    "__vbe_zdot=$ZDOTDIR\nZDOTDIR=$HOME\n[[ -r $HOME/.zshenv ]] && source $HOME/.zshenv\n__vbe_user=$ZDOTDIR\nZDOTDIR=$__vbe_zdot\n",
  )
  await fsPromises.writeFile(path.join(dir, ".zprofile"), user(".zprofile"))
  await fsPromises.writeFile(path.join(dir, ".zshrc"), user(".zshrc") + history)
  await fsPromises.writeFile(path.join(dir, ".zlogin"), user(".zlogin") + history)
}

const releaseStandIn = () =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const at = new URL(req.url).pathname
      if (at.endsWith("/@vibest/cli/beta")) return Response.json({ version: buildVersion })
      if (at.endsWith("/version")) return new Response(`${buildVersion}\n`)
      return new Response("not found", { status: 404 })
    },
  })

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
  private readonly releases = releaseStandIn()
  readonly herdrSession: string
  readonly hcSocket: string
  readonly shellDir: string
  readonly ownRuntimes = new Set<string>()

  private constructor(
    readonly root: string,
    readonly profile: Profile,
  ) {
    this.vibestHome = path.join(root, "vibest")
    this.herdrSession = path.basename(root)
    this.hcSocket = path.join(root, "hc.sock")
    this.shellDir = path.join(root, "shell")
    this.config = {
      pi: path.join(root, "pi-agent"),
      claude: path.join(root, "claude"),
      cursor: path.join(root, "cursor"),
    }
    this.repository = path.join(root, "shop")
    this.origin = path.join(root, "shop-origin.git")
  }

  static async create(profile: Profile = "user"): Promise<World> {
    const tmpBase = process.platform === "darwin" ? "/tmp" : os.tmpdir()
    const root = await fsPromises.mkdtemp(path.join(tmpBase, "vbe-"))
    await fsPromises.chmod(root, 0o700)
    const w = new World(root, profile)
    for (const dir of [w.vibestHome, path.join(root, "tmp")]) await fsPromises.mkdir(dir, { mode: 0o700 })
    await claudeShadow(w.config.claude, profile)
    await fsPromises.mkdir(w.config.pi, { mode: 0o700 })
    await cursorShadow(w.config.cursor, profile, binary)
    await zshKeepingHistoryInTheWorld(w.shellDir)
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
    const login = loginEnv()
    const env: Record<string, string | undefined> = { ...login }
    Object.assign(
      env,
      {
        VIBEST_HOME: this.vibestHome,
        PI_CODING_AGENT_DIR: this.config.pi,
        CLAUDE_CONFIG_DIR: this.config.claude,
        CURSOR_CONFIG_DIR: this.config.cursor,
        PATH: [path.dirname(binary), login.PATH].join(":"),
        TMPDIR: path.join(this.root, "tmp"),
        HISTFILE: path.join(this.shellDir, ".bash_history"),
        ZDOTDIR: this.shellDir,
        HC_SOCKET: this.hcSocket,
        npm_config_registry: `http://127.0.0.1:${this.releases.port}`,
        VIBEST_DOWNLOAD_URL: `http://127.0.0.1:${this.releases.port}`,
      },
      extra,
    )
    if (env.HOME !== this.home)
      for (const name of ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY", "SSH2_CLIENT", "SSH2_TTY"]) delete env[name]
    return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined))
  }

  async run(
    cwd: string,
    argv: ReadonlyArray<string>,
    options: { env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number; unlogged?: boolean } = {},
  ): Promise<Ran> {
    const env = this.env(options.env)
    if (process.platform === "darwin" && ["cursor-agent", "agent"].includes(path.basename(argv[0]!)))
      expect(
        !!env.HOME &&
          fs
            .statSync(path.join(env.HOME, "Library", "Keychains", "login.keychain-db"), { throwIfNoEntry: false })
            ?.isFile() === true,
        "Refusing to start Cursor: HOME lacks Library/Keychains/login.keychain-db; use the macOS login home",
      )
    const p = Bun.spawn([...argv], {
      cwd,
      env,
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
    this.log.push({
      argv: argv.map(redact),
      cwd,
      result: options.unlogged
        ? { code, stdout: `<${stdout.length} bytes not kept>`, stderr: `<${stderr.length} bytes not kept>` }
        : result,
    })
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
    options: {
      cwd?: string
      env?: Record<string, string | undefined>
      stdin?: string
      timeoutMs?: number
      unlogged?: boolean
    } = {},
  ) {
    return this.run(options.cwd ?? this.repository, [binary, ...this.withSession(args)], options)
  }

  foreignTerminals(): ReadonlyArray<string> {
    const file = path.join(this.vibestHome, "vibest.db")
    if (!fs.existsSync(file)) return []
    const db = readDb(file)
    try {
      const rows = db.query(`SELECT id, runtime FROM ${SESSIONS} s`).all() as Array<{
        id: string
        runtime: string | null
      }>
      return rows.flatMap((r) => {
        const runtime = JSON.parse(r.runtime ?? "{}") as { kind?: string; id?: string }
        if (runtime.kind !== undefined && this.ownRuntimes.has(runtime.kind)) return []
        const terminal = runtime.id ?? ""
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

  async daemon(options: Parameters<World["vibest"]>[1] = {}) {
    await this.stopDaemon()
    await this.ok(["daemon"], options)
  }

  async killDaemon(pid: number | undefined) {
    expect(pid !== undefined, "no vibestd pid")
    process.kill(pid!, "SIGKILL")
    await until("vibestd gone", () => !alive(pid!), 10_000)
  }

  async close() {
    await this.stopDaemon()
    const startedHerdrSession = await fsPromises
      .stat(path.join(this.home, ".config", "herdr", "sessions", this.herdrSession))
      .then(
        () => true,
        () => false,
      )
    if (startedHerdrSession) {
      await this.run(this.root, ["herdr", "session", "stop", this.herdrSession])
      await this.run(this.root, ["herdr", "session", "delete", this.herdrSession])
    }
    for (const p of this.started) if (p.exitCode === null) p.kill()
    await Promise.all(this.started.map((p) => p.exited))
    this.releases.stop(true)
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

export const readDb = (file: string) => {
  const db = new Database(file, { readonly: true })
  db.run("PRAGMA busy_timeout = 5000")
  return db
}

export const row = <A>(w: World, sql: string, ...args: Array<string | number>) => {
  const db = readDb(path.join(w.vibestHome, "vibest.db"))
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

const secrets = () => [
  ...(process.env.VIBEST_E2E_ENV ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((pair) => pair.slice(pair.indexOf("=") + 1)),
  ...Object.entries(loginEnv())
    .filter(([name, value]) => secretName.test(name) && value.length >= 6)
    .map(([, value]) => value),
]

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const privateValues = await userPrivateValues()

export const privateIn = (text: string, words: ReadonlyArray<string> = privateValues) =>
  words.filter((w) => new RegExp(`(?<![\\w-])${escaped(w)}(?![\\w-])`).test(text))

export const redactWith = (text: string, exact: ReadonlyArray<string>, words: ReadonlyArray<string>) =>
  words.reduce(
    (t, w) => t.replace(new RegExp(`(?<![\\w-])${escaped(w)}(?![\\w-])`, "g"), "<redacted>"),
    exact.reduce((t, value) => (value === "" ? t : t.split(value).join("<redacted>")), text),
  )

export const redact = (text: string) => redactWith(text, secrets(), privateValues)

export const writeEvidence = (file: string, text: string) => fsPromises.writeFile(file, redact(text))

export const copyEvidence = async (from: string, to: string, words: ReadonlyArray<string> = privateValues) => {
  for (const e of await fsPromises.readdir(from, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const source = path.join(e.parentPath, e.name)
    const target = path.join(to, path.relative(from, source))
    await fsPromises.mkdir(path.dirname(target), { recursive: true })
    await fsPromises.writeFile(
      target,
      redactWith(await fsPromises.readFile(source, "latin1"), secrets(), words),
      "latin1",
    )
  }
}

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

const firstAnswer = (w: World, request: object) =>
  new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
    let buffer = ""
    Bun.connect({
      unix: path.join(w.vibestHome, "vibest.sock"),
      socket: {
        open: (s) => void s.write(`${JSON.stringify(request)}\n`),
        data: (s, chunk) => {
          buffer += Buffer.from(chunk).toString("utf8")
          const line = buffer.split("\n").find((l, i, all) => i < all.length - 1 && l.trim() !== "")
          if (line === undefined) return
          s.end()
          resolve(JSON.parse(line) as { result?: unknown; error?: unknown })
        },
        error: (_s, e) => reject(e),
      },
    }).catch(reject)
  })

export const vibestd = async (w: World, repo: string, method: string, params: unknown) => {
  const ping = await firstAnswer(w, { jsonrpc: "2.0", id: 1, method: "Ping", params: null, headers: [] })
  const protocol = String((ping.result as { protocol?: number } | undefined)?.protocol)
  const headers = [
    ["vibest-protocol", protocol],
    ["vibest-caller", "cli"],
    ["vibest-repository", repo],
  ]
  return firstAnswer(w, { jsonrpc: "2.0", id: 1, method, params, headers })
}

export const transcript = async (w: World, cwd: string, claudeConfig = path.join(w.home, ".claude")) => {
  const dir = path.join(claudeConfig, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  const files = (await fsPromises.readdir(dir).catch(() => [] as Array<string>)).filter((f) => f.endsWith(".jsonl"))
  const entries: Array<{ type?: string | undefined; raw: string; text: string }> = []
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
