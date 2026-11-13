import { Database } from "bun:sqlite"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { commandOf, note } from "../../reap.ts"
import { entryModel, entryRunMessage, nextEntryRun } from "./fake-model.ts"
import {
  herdrConfigSessions,
  pathsNamed,
  removeStoppedSession,
  sessionNamesForWorld,
  worldTmpBase,
} from "./runner/cleanup.ts"
import { alive } from "./world/alive.ts"
import { claudeShadow, cursorShadow, piShadow, type Profile, userPrivateValues } from "./world/shadow.ts"
import { endHerdrSocket, stopOwners, stopRecordedDaemon, stopSocketsUnder } from "./world/teardown.ts"
import { secretName } from "./world/user-env.ts"

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
  const compiled = path.join(checkout, "packages/cli/dist/vibest")
  return { binary: compiled, compiled, harnesses: path.join(checkout, "packages/cli/harnesses") }
}
export const { binary, compiled, harnesses } = target()

export const buildVersion = (
  JSON.parse(fs.readFileSync(path.join(checkout, "packages/cli/package.json"), "utf8")) as { version: string }
).version

const shSingle = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
const shWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : shSingle(s))

const zshKeepingHistoryInTheWorld = async (dir: string) => {
  await fsPromises.mkdir(dir, { mode: 0o700 })
  const first = `PATH=${shSingle(path.dirname(binary))}:$PATH\nexport PATH\n`
  const user = (file: string) =>
    `ZDOTDIR=$__vbe_user\n[[ -r $ZDOTDIR/${file} ]] && source $ZDOTDIR/${file}\nZDOTDIR=$__vbe_zdot\n${first}`
  const history = "HISTFILE=$__vbe_zdot/.zsh_history\n"
  await fsPromises.writeFile(
    path.join(dir, ".zshenv"),
    `__vbe_zdot=$ZDOTDIR\nZDOTDIR=$HOME\n[[ -r $HOME/.zshenv ]] && source $HOME/.zshenv\n__vbe_user=$ZDOTDIR\nZDOTDIR=$__vbe_zdot\n${first}`,
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

export { alive } from "./world/alive.ts"
export { removeExpiredWorlds, removeWorldDir } from "./world/teardown.ts"

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
  private readonly entryModels: Array<{ readonly stop: () => void }> = []
  private readonly hcCores = new Map<string, number>()
  private readonly daemons = new Map<string, number>()

  private constructor(
    readonly root: string,
    readonly profile: Profile,
    readonly login: Readonly<Record<string, string>>,
  ) {
    this.redact = redactor(login)
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

  readonly redact: (text: string) => string

  writeEvidence(file: string, text: string) {
    return fsPromises.writeFile(file, this.redact(text))
  }

  copyEvidence(from: string, to: string, words: ReadonlyArray<string> = privateValues) {
    return copyEvidence(this.login, from, to, words)
  }

  static async create(login: Readonly<Record<string, string>>, profile: Profile = "user"): Promise<World> {
    const root = await fsPromises.mkdtemp(path.join(worldTmpBase(), "vbe-"))
    await fsPromises.chmod(root, 0o700)
    const w = new World(root, profile, login)
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
    const env: Record<string, string | undefined> = { ...this.login }
    Object.assign(
      env,
      {
        VIBEST_HOME: this.vibestHome,
        PI_CODING_AGENT_DIR: this.config.pi,
        CLAUDE_CONFIG_DIR: this.config.claude,
        CURSOR_CONFIG_DIR: this.config.cursor,
        PATH: [path.dirname(binary), this.login.PATH].join(":"),
        TMPDIR: path.join(this.root, "tmp"),
        HISTFILE: path.join(this.shellDir, ".bash_history"),
        ZDOTDIR: this.shellDir,
        HC_SOCKET: this.hcSocket,
        GIT_AUTHOR_NAME: "vibest e2e",
        GIT_AUTHOR_EMAIL: "e2e@vibest.invalid",
        GIT_COMMITTER_NAME: "vibest e2e",
        GIT_COMMITTER_EMAIL: "e2e@vibest.invalid",
        npm_config_registry: `http://127.0.0.1:${this.releases.port}`,
        VIBEST_DOWNLOAD_URL: `http://127.0.0.1:${this.releases.port}`,
        VIBEST_NO_UPDATE_CHECK: "1",
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
      argv: argv.map(this.redact),
      cwd,
      result: options.unlogged
        ? { code, stdout: `<${stdout.length} bytes not kept>`, stderr: `<${stderr.length} bytes not kept>` }
        : result,
    })
    if (!argv.includes("import-check")) await this.noteDaemon(env.VIBEST_HOME)
    if (path.basename(argv[0]!) === "hc") this.noteHcCore(env)
    return result
  }

  withSession(args: ReadonlyArray<string>): ReadonlyArray<string> {
    const launch =
      args[0] === "run" ||
      args.length === 0 ||
      (args[0]!.startsWith("-") && args[0] !== "--version" && args[0] !== "--help")
    if (!launch) return args
    const sessioned = args.includes("--session")
      ? args
      : args[0] === "run"
        ? ["run", "--session", this.herdrSession, ...args.slice(1)]
        : ["--session", this.herdrSession, ...args]
    if (sessioned.includes("--runtime")) return sessioned
    return sessioned[0] === "run"
      ? ["run", "--runtime", "herdr", ...sessioned.slice(1)]
      : ["--runtime", "herdr", ...sessioned]
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

  async entryOf(cwd: string, home = this.vibestHome) {
    const file = path.join(home, "vibest.db")
    if (!fs.existsSync(file)) return undefined
    const directory = await fsPromises.realpath(cwd)
    const db = readDb(file)
    try {
      const found = db
        .query(
          `SELECT s.id FROM project p JOIN session s ON s.id = p.entry_session_id
            WHERE p.directory = ? AND s.ended_at IS NULL`,
        )
        .get(directory) as { id: string } | null
      return found?.id
    } finally {
      db.close()
    }
  }

  async entry(options: Omit<Parameters<World["startEntry"]>[0], "harness" | "env" | "timeoutMs"> = {}) {
    if ((await this.entryOf(options.cwd ?? this.repository)) !== undefined) return
    await this.ok(["daemon"], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.processEnv ?? {},
    })
    const model = entryModel()
    this.entryModels.push(model)
    const dir = await piShadow(path.join(this.root, `pi-entry-${this.entryModels.length}`), this.profile, {
      fake: { baseUrl: model.url },
    })
    if (options.runtime !== "hc" && options.socket === undefined)
      await this.ensureHerdr(options.session ?? this.herdrSession, this.env(options.processEnv))
    await this.startEntry({ ...options, harness: "pi", env: { PI_CODING_AGENT_DIR: dir }, timeoutMs: 90_000 })
    const cwd = options.cwd ?? this.repository
    await until("the entry session", async () => (await this.entryOf(cwd)) !== undefined, 90_000)
  }

  async viaEntry(
    args: ReadonlyArray<string>,
    options: {
      cwd?: string
      env?: Record<string, string | undefined>
      timeoutMs?: number
      bin?: string
      asIs?: boolean
    } = {},
  ): Promise<Ran> {
    const cwd = options.cwd ?? this.repository
    let entry: string | undefined
    await until(
      `the entry session in ${cwd} to run vibest ${args.join(" ")}`,
      async () => (entry = await this.entryOf(cwd, options.env?.VIBEST_HOME)) !== undefined,
      60_000,
    )
    const run = nextEntryRun()
    const vars = Object.entries(options.env ?? {})
    const env = [
      ...vars.flatMap(([key, value]) => (value === undefined ? ["-u", key] : [])),
      ...vars.flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`])),
    ]
    const argv = [
      ...(env.length > 0 ? ["env", ...env] : []),
      options.bin ?? binary,
      ...(options.asIs ? args : this.withSession(args)),
    ]
    const vibest = (more: ReadonlyArray<string>) =>
      this.run(cwd, [options.bin ?? binary, ...more], options.env === undefined ? {} : { env: options.env })
    const out = path.join(this.root, `entry-run-${run}`)
    const command = `{ ${argv.map(shWord).join(" ")}; } > ${shWord(out)} 2>&1; echo $? > ${shWord(`${out}.exit.tmp`)} && mv ${shWord(`${out}.exit.tmp`)} ${shWord(`${out}.exit`)}`
    const sent = await vibest(["send", entry!, "--", entryRunMessage(run, command)])
    expect(sent.code === 0, `vibest send to the entry exited ${sent.code}: ${sent.stderr}${sent.stdout}`)
    await until(
      `the entry session to run vibest ${args.join(" ")}`,
      () => publishedStatus(`${out}.exit`) !== undefined,
      (options.timeoutMs ?? 60_000) + 60_000,
    )
    const code = publishedStatus(`${out}.exit`)!
    const output = fs.readFileSync(out, "utf8").trim()
    const result = { code, stdout: output, stderr: output }
    this.log.push({ argv: ["(entry)", binary, ...args].map(this.redact), cwd, result })
    return result
  }

  async okViaEntry(args: ReadonlyArray<string>, options: Parameters<World["viaEntry"]>[1] = {}): Promise<string> {
    const r = await this.viaEntry(args, options)
    expect(
      r.code === 0,
      `vibest ${args.join(" ")} (from the entry) exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`,
    )
    return r.stdout
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

  private noteHerdr(session: string, socket: string) {
    const pids = Bun.spawnSync(["lsof", "-t", socket], { stdout: "pipe", stderr: "ignore" })
      .stdout.toString()
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1)
    for (const pid of new Set(pids)) {
      const command = commandOf(pid).trim()
      if (command.includes("herdr") && command.includes(session)) note(pid, command, this.root)
    }
  }

  private noteHcCore(env: Record<string, string | undefined>) {
    const runtimeDir = env.XDG_RUNTIME_DIR
    const socket =
      env.HC_SOCKET ??
      (runtimeDir === undefined
        ? undefined
        : path.join(runtimeDir, "herdr-core", `${env.HC_SESSION ?? "default"}.sock`))
    if (socket === undefined || !socket.startsWith(`${this.root}/`) || !fs.existsSync(socket)) return
    const known = this.hcCores.get(socket)
    if (known !== undefined && alive(known)) return
    const pids = Bun.spawnSync(["lsof", "-t", socket], { stdout: "pipe", stderr: "ignore" })
      .stdout.toString()
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1)
    for (const pid of new Set(pids)) {
      const command = commandOf(pid).trim()
      if (!/^\S*\bhc\s/.test(command)) continue
      note(pid, command, this.root, this.root)
      this.hcCores.set(socket, pid)
    }
  }

  private async noteDaemon(home: string | undefined) {
    if (home === undefined) return
    const text = await fsPromises.readFile(path.join(home, "vibestd.pid"), "utf8").catch(() => "")
    let parsed: { pid?: unknown; command?: unknown }
    try {
      parsed = JSON.parse(text) as { pid?: unknown; command?: unknown }
    } catch {
      return
    }
    if (typeof parsed.pid !== "number" || !Array.isArray(parsed.command) || this.daemons.get(home) === parsed.pid)
      return
    const marker = parsed.command.filter((part): part is string => typeof part === "string").join(" ")
    if (marker === "" || !commandOf(parsed.pid).includes("daemon --foreground")) return
    note(parsed.pid, marker, this.root)
    this.daemons.set(home, parsed.pid)
  }

  private async ensureHerdr(session: string, env: Record<string, string>) {
    const socket = path.join(this.home, ".config", "herdr", "sessions", session, "herdr.sock")
    if (fs.existsSync(socket)) {
      this.noteHerdr(session, socket)
      return socket
    }
    const server = Bun.spawn(["herdr", "server", "--session", session], {
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    server.unref()
    this.started.push(server)
    note(server.pid, `herdr server --session ${session}`, this.root)
    await until(`herdr session ${session}`, () => fs.existsSync(socket), 20_000)
    this.noteHerdr(session, socket)
    return socket
  }

  async startEntry(input: {
    readonly harness?: string
    readonly env?: Record<string, string>
    readonly cwd?: string
    readonly session?: string
    readonly socket?: string
    readonly runtime?: string
    readonly extra?: ReadonlyArray<string>
    readonly bin?: string
    readonly name?: string
    readonly timeoutMs?: number
    readonly processEnv?: Record<string, string | undefined>
    readonly hc?: {
      readonly run: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
      readonly terminal?: string
    }
  }) {
    const cwd = input.cwd ?? this.repository
    const timeoutMs = input.timeoutMs ?? 60_000
    const vars = input.env ?? {}
    if (input.runtime === "hc") {
      if (input.hc === undefined) throw new Error("startEntry on hc needs the check's hc runner")
      const name = input.hc.terminal ?? input.name ?? `main-${Date.now()}`
      if (input.hc.terminal === undefined) {
        const opened = await input.hc.run("run", "--bg", "--keep", "--name", name)
        expect(opened.code === 0, `hc run: ${opened.stderr}${opened.stdout}`)
      }
      const prefix = Object.entries(vars)
        .map(([key, value]) => `${key}=${shSingle(value)}`)
        .join(" ")
      const program = input.bin ?? "vibest"
      const args = [program, ...(input.harness ? ["--harness", input.harness] : []), ...(input.extra ?? [])]
        .map(shSingle)
        .join(" ")
      const typed = await input.hc.run(
        "send",
        name,
        `cd ${shSingle(cwd)} && ${prefix} ${args}`.replace(/ +/g, " ").trim(),
      )
      expect(typed.code === 0, `hc send: ${typed.stderr}${typed.stdout}`)
    } else {
      const session = input.session ?? this.herdrSession
      const socket = input.socket ?? (await this.ensureHerdr(session, this.env()))
      const workspace = await herdr(socket, "workspace.create", { cwd, focus: false, label: "project" })
      const workspaceId = (workspace.workspace as { workspace_id: string }).workspace_id
      const created = await herdr(socket, "tab.create", {
        cwd,
        env: { ...this.env(input.processEnv), ...vars },
        focus: true,
        workspace_id: workspaceId,
      })
      const pane = (created.root_pane as { pane_id: string }).pane_id
      const shells = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu"])
      await until(
        "the pane shell",
        async () => {
          const info = await herdr(socket, "pane.process_info", { pane_id: pane })
          const fg =
            (info.process_info as { foreground_processes?: Array<{ name: string }> } | undefined)
              ?.foreground_processes ?? []
          return fg.length > 0 && fg.every((proc) => shells.has(proc.name.replace(/^-/, "").replace(/^.*\//, "")))
        },
        30_000,
      )
      const program = input.bin ?? binary
      const args = [program, ...(input.harness ? ["--harness", input.harness] : []), ...(input.extra ?? [])]
        .map(shSingle)
        .join(" ")
      await herdr(socket, "pane.send_text", { pane_id: pane, text: args })
      await herdr(socket, "pane.send_keys", { pane_id: pane, keys: ["enter"] })
    }
    await until(
      "the entry session",
      () => {
        const file = path.join(this.vibestHome, "vibest.db")
        if (!fs.existsSync(file)) return false
        const db = readDb(file)
        try {
          return db.query("SELECT id FROM session WHERE agent = 'coordinator' AND ended_at IS NULL").get() !== null
        } catch {
          return false
        } finally {
          db.close()
        }
      },
      timeoutMs,
    )
    await this.noteDaemon(this.vibestHome)
    if (typeof input.env?.VIBEST_HOME === "string") await this.noteDaemon(input.env.VIBEST_HOME)
    if (typeof input.processEnv?.VIBEST_HOME === "string") await this.noteDaemon(input.processEnv.VIBEST_HOME)
  }

  private async killStarted() {
    for (const p of this.started) if (p.exitCode === null) p.kill()
    const deadline = Date.now() + 3_000
    while (this.started.some((p) => p.exitCode === null) && Date.now() < deadline) await Bun.sleep(50)
    for (const p of this.started) {
      if (p.exitCode !== null || p.pid === undefined) continue
      try {
        process.kill(p.pid, "SIGKILL")
      } catch (e) {
        if (!(e instanceof Error) || !("code" in e) || e.code !== "ESRCH") throw e
      }
    }
    await Promise.all(this.started.map((p) => p.exited))
  }

  async close() {
    const errors: Array<unknown> = []
    const step = async (run: () => Promise<void>) => {
      try {
        await run()
      } catch (e) {
        errors.push(e)
      }
    }
    const sessionsDir = herdrConfigSessions(this.home)
    const run = (args: ReadonlyArray<string>, extra: Record<string, string | undefined> = {}) =>
      this.run(this.root, ["herdr", ...args], { timeoutMs: 20_000, env: extra })
    const names = sessionNamesForWorld(
      await fsPromises.readdir(sessionsDir).catch(() => [] as Array<string>),
      this.herdrSession,
    )
    try {
      await step(() => this.stopDaemon())
      await step(() => stopRecordedDaemon(this.root))
      for (const name of names) await step(() => run(["session", "stop", name]).then(() => undefined))
      await step(() => stopSocketsUnder(this.root, (args, extra) => run(args, extra)))
      for (const name of names) await step(() => endHerdrSocket(path.join(sessionsDir, name, "herdr.sock"), name))
      for (const sock of await pathsNamed(this.root, "hc.sock"))
        await step(() =>
          this.run(this.root, ["hc", "server", "stop"], { timeoutMs: 15_000, env: { HC_SOCKET: sock } }).then(
            () => undefined,
          ),
        )
      await step(() => this.killStarted())
      await step(() => stopOwners(this.root))
      for (const name of names) {
        await step(() => run(["session", "delete", name]).then(() => undefined))
        await step(() => removeStoppedSession(path.join(sessionsDir, name)).then(() => undefined))
      }
    } finally {
      this.releases.stop(true)
      for (const model of this.entryModels) model.stop()
    }
    if (errors[0] !== undefined) throw errors[0]
  }
}

export const SESSIONS = `(SELECT s.id, s.project_id, s.agent AS agent_type, s.directory, s.created_at, s.ended_at,
    p.harness, p.provider,
    CASE WHEN p.id IS NULL THEN NULL ELSE json_object('kind', p.runtime, 'id', coalesce(p.terminal, '')) END AS runtime,
    p.conversation AS harness_session_id, p.pid, p.integration_version AS version,
    p.ended_at AS exited_at
  FROM session s LEFT JOIN process p ON p.session_id = s.id AND p.id = (SELECT max(id) FROM process WHERE session_id = s.id))`

export const EXECUTIONS = `(SELECT id, session_id, coalesce(outcome, 'working') AS status FROM execution)`

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

export const rows = <A>(w: World, sql: string, ...args: Array<string | number>) => {
  const db = readDb(path.join(w.vibestHome, "vibest.db"))
  try {
    return db.query(sql).all(...args) as Array<A>
  } finally {
    db.close()
  }
}

export const factsOf = (w: World, sessionId: string) =>
  rows<{ type: string }>(w, "SELECT type FROM event WHERE aggregate = ? ORDER BY seq", sessionId).map((r) => r.type)

export const expectFacts = (w: World, sessionId: string, expected: ReadonlyArray<string>) => {
  const recorded = factsOf(w, sessionId)
  let next = 0
  for (const type of recorded) if (type === expected[next]) next++
  expect(
    next === expected.length,
    `session ${sessionId} recorded ${recorded.join(", ")}, not ${expected.join(", ")} in that order`,
  )
}

export const expectReplied = async (w: World, sub: string) => {
  expectFacts(w, sub, [
    "session.created",
    "process.started",
    "inbox.queued",
    "process.placed",
    "execution.started",
    "inbox.moved",
    "execution.ended",
  ])
  const task = row<{ status: string; execution: number | null }>(
    w,
    "SELECT status, execution_id AS execution FROM inbox WHERE session_id = ? AND kind = 'task'",
    sub,
  )
  expect(task?.status === "delivered" && task.execution !== null, `${sub}'s task row: ${JSON.stringify(task)}`)
  const execution = row<{ status: string; reply: string | null }>(
    w,
    "SELECT outcome AS status, reply FROM execution WHERE session_id = ? AND id = ?",
    sub,
    task!.execution!,
  )
  expect(
    execution?.status === "completed" && typeof execution.reply === "string",
    `${sub}'s task execution: ${JSON.stringify(execution)}`,
  )
}

const READ_MODEL = ["session", "process", "execution", "inbox"] as const

export const ledgerSnapshot = (home: string) => {
  const file = path.join(home, "vibest.db")
  if (!fs.existsSync(file)) return undefined
  const db = readDb(file)
  try {
    const facts = (
      db.query("SELECT aggregate, seq, at, type, data FROM event ORDER BY position").all() as Array<{
        data: string
      }>
    ).map((fact) => ({ ...fact, data: JSON.parse(fact.data) as unknown }))
    return {
      facts,
      ...Object.fromEntries(
        READ_MODEL.map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
      ),
    }
  } finally {
    db.close()
  }
}

export const exitStatusOf = (content: string) => (/^\d+\s*$/.test(content) ? Number(content) : undefined)

const publishedStatus = (file: string) =>
  fs.existsSync(file) ? exitStatusOf(fs.readFileSync(file, "utf8")) : undefined

export const until = async (what: string, ok: () => Promise<boolean> | boolean, timeoutMs = 10_000) => {
  for (const deadline = Date.now() + timeoutMs; !(await ok()); await Bun.sleep(100))
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`)
}

const secrets = (login: Readonly<Record<string, string>>) => [
  ...(process.env.VIBEST_E2E_ENV ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((pair) => pair.slice(pair.indexOf("=") + 1)),
  ...Object.entries(login)
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

export const redactor = (login: Readonly<Record<string, string>>) => (text: string) =>
  redactWith(text, secrets(login), privateValues)

export const copyEvidence = async (
  login: Readonly<Record<string, string>>,
  from: string,
  to: string,
  words: ReadonlyArray<string>,
) => {
  for (const e of await fsPromises.readdir(from, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const source = path.join(e.parentPath, e.name)
    const target = path.join(to, path.relative(from, source))
    await fsPromises.mkdir(path.dirname(target), { recursive: true })
    await fsPromises.writeFile(
      target,
      redactWith(await fsPromises.readFile(source, "latin1"), secrets(login), words),
      "latin1",
    )
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

export const replyOf = async (w: World, sub: string, cwd?: string) =>
  (await w.json<{ reply?: { text?: string | null } | null }>(["result", sub], cwd === undefined ? {} : { cwd })).reply
    ?.text ?? ""

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
