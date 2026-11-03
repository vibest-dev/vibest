import { Database } from "bun:sqlite"
// One world per run: the user's own HOME (the harnesses' logins live in its keychain), a temp VIBEST_HOME, temp config
// directories for each harness (Pi, Claude, Cursor read them from env), a scratch repository with a local bare origin, and
// the vibest under test first on PATH. vibest writes nothing outside the temp root. Every process this run starts is stopped.
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const checkout = path.resolve(import.meta.dirname, "../../..")

/**
 * The vibest under test. `pnpm verify` installs it as a user does and sets VIBEST_E2E_METHOD and VIBEST_E2E_INSTALL:
 * npm (an npm prefix with @vibest/cli and the platform package) or curl (install.sh's VIBEST_BIN at `bin/`, VIBEST_INSTALL
 * at `share/`). Unset: this checkout's build (`pnpm run build`).
 */
export const method = (process.env.VIBEST_E2E_METHOD ?? "build") as "build" | "npm" | "curl"
const install = process.env.VIBEST_E2E_INSTALL ?? ""
const target = () => {
  if (method === "npm") {
    const modules = path.join(install, "node_modules")
    return {
      // npm's launcher, bin/vibest.cjs, which sets VIBEST_HARNESSES.
      binary: path.join(modules, ".bin/vibest"),
      compiled: path.join(modules, "@vibest", `cli-${process.platform}-${process.arch}`, "bin/vibest"),
      harnesses: path.join(modules, "@vibest/cli/harnesses"),
    }
  }
  if (method === "curl") {
    // The link install.sh made, to the version it installed; the binary finds its plugins beside its bin/.
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
/** The `vibest` a user runs, the compiled binary behind it, and vibest's plugin for each harness, as installed. */
export const { binary, compiled, harnesses } = target()

export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** A check that cannot run here (missing CLI); reported as skipped, never as passed. */
export class Skip extends Error {}

export const fail = (message: string): never => {
  throw new Error(message)
}

export const expect = (ok: boolean, message: string) => {
  if (!ok) fail(message)
}

export class World {
  /** The user's real HOME: read, never written. */
  readonly home = os.homedir()
  readonly vibestHome: string
  /** PI_CODING_AGENT_DIR, CLAUDE_CONFIG_DIR, CURSOR_CONFIG_DIR: each harness's config, in the temp root. */
  readonly config: { readonly pi: string; readonly claude: string; readonly cursor: string }
  readonly repository: string
  readonly origin: string
  readonly log: Array<{ readonly argv: ReadonlyArray<string>; readonly cwd: string; readonly result: Ran }> = []
  private readonly started: Array<ReturnType<typeof Bun.spawn>> = []
  /** The herdr session this run uses (`vibest … --session`), never the user's; stopped at the end. */
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
    // Short: vibest.sock lives in VIBEST_HOME, and a Unix socket path is at most 104 bytes on macOS.
    const root = await fsPromises.mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "vbe-"))
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

  /** The user's environment inside this world: no inherited vibest or herdr role; vibest's and the harnesses' state in the temp root. */
  env(extra: Record<string, string | undefined> = {}): Record<string, string> {
    const env: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(process.env))
      if (!k.startsWith("VIBEST_") && !k.startsWith("HERDR_")) env[k] = v
    Object.assign(
      env,
      {
        VIBEST_HOME: this.vibestHome,
        // Installed, npm's launcher sets it as for a user; the build finds its plugins beside itself.
        PI_CODING_AGENT_DIR: this.config.pi,
        CLAUDE_CONFIG_DIR: this.config.claude,
        CURSOR_CONFIG_DIR: this.config.cursor,
        // The built vibest first (harness plugins run `vibest` from PATH), and where cursor-agent installs itself.
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

  /**
   * `args` with this world's herdr session for the commands that open panes (`run`, and bare `vibest` starting the main
   * agent) when they name none: vibest's default is the session `vibest`, the user's own.
   */
  withSession(args: ReadonlyArray<string>): ReadonlyArray<string> {
    if (args.includes("--session")) return args
    if (args[0] === "run") return ["run", "--session", this.herdrSession, ...args.slice(1)]
    if (args.length === 0 || (args[0]!.startsWith("-") && args[0] !== "--version" && args[0] !== "--help"))
      return ["--session", this.herdrSession, ...args]
    return args
  }

  /** `vibest …` from the repository (or `cwd`), in this world's herdr session unless `args` name one. */
  vibest(
    args: ReadonlyArray<string>,
    options: { cwd?: string; env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number } = {},
  ) {
    return this.run(options.cwd ?? this.repository, [binary, ...this.withSession(args)], options)
  }

  /**
   * Terminals vibest recorded outside this world's herdr sessions (its own and the ones a check names after it,
   * `<session>-…`): a check that opened a pane in a session it does not own, the user's included.
   */
  foreignTerminals(): ReadonlyArray<string> {
    const file = path.join(this.vibestHome, "vibest.db")
    if (!fs.existsSync(file)) return []
    const db = new Database(file, { readonly: true })
    try {
      const rows = db.query("SELECT id, runtime FROM session").all() as Array<{ id: string; runtime: string | null }>
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

  /**
   * `vibest …` on a pseudo-terminal (Python's `pty`), typing `answers` as a user would: what asks before writing a user file or
   * replacing vibestd only asks on a terminal. Output has CR LF line ends.
   */
  tty(
    args: ReadonlyArray<string>,
    answers: string,
    options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
  ) {
    const pty = ["python3", "-I", path.join(import.meta.dirname, "terminal.py"), binary, ...this.withSession(args)]
    return this.run(options.cwd ?? this.repository, pty, { ...options, stdin: answers })
  }

  /** Must exit 0; returns stdout. */
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

  /** A foreground process this run owns (vibestd); stopped at the end. */
  spawn(argv: ReadonlyArray<string>, log: string) {
    const p = Bun.spawn([...argv], { cwd: this.repository, env: this.env(), stdout: "ignore", stderr: Bun.file(log) })
    this.started.push(p)
    return p
  }

  /** The PID vibestd recorded in this world's VIBEST_HOME, if any. */
  async daemonPid(): Promise<number | undefined> {
    const text = await fsPromises.readFile(path.join(this.vibestHome, "vibestd.pid"), "utf8").catch(() => "")
    try {
      const pid = (JSON.parse(text) as { pid?: unknown }).pid
      return typeof pid === "number" && pid > 0 ? pid : undefined
    } catch {
      return undefined
    }
  }

  /** Stop the vibestd of this world only (its recorded PID), and every process this run spawned. */
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
    // The herdr server vibest started for this run (detached), if it did; the user's sessions are never touched.
    if (
      await fsPromises.stat(path.join(this.home, ".config", "herdr", "sessions", this.herdrSession)).then(
        () => true,
        () => false,
      )
    ) {
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

/** One row of vibest.db, read while vibestd runs. */
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

/** Is `bin` on the world's PATH? */
/** VIBEST_E2E_ENV: KEY=VALUE pairs, one per line, for the agents a real-model check starts. */
const agentEnv = (process.env.VIBEST_E2E_ENV ?? "")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))

/** `text` with every VIBEST_E2E_ENV value replaced: they are never printed or kept as evidence. */
export const redact = (text: string) =>
  agentEnv.reduce((t, pair) => {
    const value = pair.slice(pair.indexOf("=") + 1)
    return value === "" ? t : t.split(value).join("<redacted>")
  }, text)

/**
 * The model of the agents a real-model check has vibest start, as vibest's own options (`vibest run` and the main
 * agent's `vibest` take the same `--provider`, `--model` and `--env`). VIBEST_E2E_PROVIDER and VIBEST_E2E_MODEL choose
 * it, VIBEST_E2E_ENV adds environment (another Anthropic-compatible endpoint for Claude, say); unset, Claude Haiku as
 * before. The one place to change it. The World's own environment drops every VIBEST_* variable, so these reach no
 * agent except as these options.
 */
export const agentModel = (): ReadonlyArray<string> => {
  const provider = process.env.VIBEST_E2E_PROVIDER
  return [
    ...(provider ? ["--provider", provider] : []),
    "--model",
    process.env.VIBEST_E2E_MODEL || "haiku",
    ...agentEnv.flatMap((pair) => ["--env", pair]),
  ]
}

export const onPath = (bin: string) => Bun.which(bin) !== null

/**
 * Sessions vibestd knows, without starting a harness: rows in a project of their own (`key`), for an integration that
 * calls vibestd over HTTP, which answers only a known session. Starts vibestd first; returns the project id.
 */
export const knownSessions = async (
  w: World,
  key: string,
  sessions: Record<string, string>,
  directory = w.repository,
) => {
  await w.ok(["ls"])
  const db = new Database(path.join(w.vibestHome, "vibest.db"))
  try {
    const project = db
      .query<{ id: number }, [string]>("INSERT INTO project (directory) VALUES (?) RETURNING id")
      .get(key)!.id
    for (const [id, agent] of Object.entries(sessions))
      db.run(
        "INSERT INTO session (id, project_id, agent_type, harness, directory, created_at) VALUES (?, ?, ?, 'claude', ?, ?)",
        [id, project, agent, directory, Date.now()],
      )
    return project
  } finally {
    db.close()
  }
}
