import type { GuardCall } from "@vibest/plugin/effect"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect"

import { Agents } from "./agents.ts"
import { Harnesses } from "./harnesses.ts"
import { Runtimes } from "./runtimes.ts"

export interface ToolCall {
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
  readonly cwd: string
}

const PATH_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "notebookread",
  "ls",
  "grep",
  "glob",
  "find",
  "delete",
  "list",
  "readlints",
])
const SEARCH_TOOLS = new Set(["grep", "glob", "find"])
const EDIT_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"])
const fileWritingTool = (tool: string) => {
  const name = tool.toLowerCase()
  return EDIT_TOOLS.has(name) || name === "delete" || name === "strreplace"
}
const SHELL_TOOLS = new Set(["bash", "powershell", "shell"])
const shellCommand = (input: Readonly<Record<string, unknown>>) => str(input.command)

const closingParenIgnoringQuotes = (s: string, open: number) => {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++
    else if (s[i] === ")" && --depth === 0) return i
  }
  return -1
}

const FILE_DESCRIPTOR = /^\d+$/

export const splitCommand = (command: string): ReadonlyArray<ReadonlyArray<string>> => {
  const commands: Array<Array<string>> = [[]]
  const nested: Array<string> = []
  const heredocs: Array<string> = []
  let word: string | undefined
  let quote: "'" | '"' | undefined
  let nextWordIsRedirectTarget = false
  const end = () => {
    if (word !== undefined && nextWordIsRedirectTarget) nextWordIsRedirectTarget = false
    else if (word !== undefined) commands.at(-1)!.push(word)
    word = undefined
  }
  const next = () => {
    end()
    nextWordIsRedirectTarget = false
    commands.push([])
  }
  const s = command
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote === "'") {
      if (c === "'") quote = undefined
      else word = (word ?? "") + c
    } else if (c === "`" || (c === "$" && s[i + 1] === "(")) {
      const close = c === "`" ? s.indexOf("`", i + 1) : closingParenIgnoringQuotes(s, i + 1)
      const stop = close === -1 ? s.length : close
      nested.push(s.slice(c === "`" ? i + 1 : i + 2, stop))
      word = (word ?? "") + s.slice(i, stop + 1)
      i = stop
    } else if (quote === '"') {
      if (c === '"') quote = undefined
      else if (c === "\\" && i + 1 < s.length) word = (word ?? "") + s[++i]
      else word = (word ?? "") + c
    } else if (c === "'" || c === '"') {
      quote = c
      word ??= ""
    } else if (c === "\\" && i + 1 < s.length) {
      if (s[++i] !== "\n") word = (word ?? "") + s[i]
    } else if (c === " " || c === "\t") {
      end()
    } else if (c === "#" && word === undefined) {
      while (i + 1 < s.length && s[i + 1] !== "\n") i++
    } else if (c === "\n" || c === "\r") {
      next()
      for (const delimiter of heredocs.splice(0)) {
        while (i < s.length) {
          const eol = s.indexOf("\n", i + 1)
          const line = s.slice(i + 1, eol === -1 ? s.length : eol)
          i = eol === -1 ? s.length : eol
          if (line.replace(/^\t+/, "").replace(/\r$/, "") === delimiter) break
        }
      }
    } else if (c === "<" || c === ">") {
      if (word !== undefined && FILE_DESCRIPTOR.test(word)) word = undefined
      end()
      if (c === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
        i += s[i + 2] === "-" ? 2 : 1
        const m = /^\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(s.slice(i + 1))
        if (m) {
          heredocs.push((m[1] ?? m[2] ?? m[3]!).replace(/\\/g, ""))
          i += m[0].length
        }
      } else {
        while (">&|<".includes(s[i + 1] ?? "x")) i++
        nextWordIsRedirectTarget = true
      }
    } else if ("|&;()".includes(c)) {
      next()
    } else {
      word = (word ?? "") + c
    }
  }
  end()
  return [...commands.filter((argv) => argv.length > 0), ...nested.flatMap(splitCommand)]
}

const IDENTITY = /^VIBEST_SESSION_ID(?:=|$)/
const base = (word: string) => word.slice(word.lastIndexOf("/") + 1)
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
  command: [],
  builtin: [],
  exec: ["-a"],
  nohup: [],
  time: [],
  nice: ["-n"],
  timeout: ["-s", "-k"],
  sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-U", "-r", "-t"],
  xargs: ["-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a"],
}
const KEYWORDS = new Set(["!", "{", "if", "then", "elif", "else", "do", "while", "until"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const VARIABLE_SETTERS = new Set(["unset", "export", "declare", "typeset", "readonly", "local"])

interface Program {
  readonly argv: ReadonlyArray<string>
  readonly identity: boolean
}

const programs = (argv: ReadonlyArray<string>, identity = false): ReadonlyArray<Program> => {
  let i = 0
  for (;;) {
    const w = argv[i]
    if (w === undefined) return identity ? [{ argv: [], identity }] : []
    const name = base(w)
    if (/^[A-Za-z_]\w*=/.test(w)) {
      identity ||= IDENTITY.test(w)
      i++
    } else if (KEYWORDS.has(w)) {
      i++
    } else if (Object.hasOwn(WRAPPER_VALUE_OPTIONS, name)) {
      for (i++; argv[i]?.startsWith("-"); i++) {
        const o = argv[i]!
        if (o === "--") {
          i++
          break
        }
        if (name === "env")
          identity ||=
            o === "-" ||
            o === "--ignore-environment" ||
            /^-[^-]*i/.test(o) ||
            IDENTITY.test(o.replace(/^(?:-u|--unset=)/, ""))
        if (WRAPPER_VALUE_OPTIONS[name]!.includes(o)) {
          if (name === "env" && (o === "-u" || o === "--unset")) identity ||= IDENTITY.test(argv[i + 1] ?? "")
          i++
        }
      }
      if (name === "timeout") i++
    } else if (SHELLS.has(name)) {
      const c = argv.findIndex((x, j) => j > i && /^-[a-z]*c[a-z]*$/.test(x))
      return c === -1
        ? [{ argv: argv.slice(i), identity }]
        : splitCommand(argv[c + 1] ?? "").flatMap((a) => programs(a, identity))
    } else if (name === "eval") {
      return splitCommand(argv.slice(i + 1).join(" ")).flatMap((a) => programs(a, identity))
    } else {
      return [{ argv: argv.slice(i), identity }]
    }
  }
}

const programsOf = (command: string): ReadonlyArray<Program> => {
  const all = splitCommand(command).flatMap((argv) => programs(argv))
  const changed = all.some(
    (p) => p.argv.length === 0 || (VARIABLE_SETTERS.has(p.argv[0]!) && p.argv.slice(1).some((w) => IDENTITY.test(w))),
  )
  return changed ? all.map((p) => ({ ...p, identity: true })) : all
}

const vibestArgs = (vibest: ReadonlyArray<string>, argv: ReadonlyArray<string>) => {
  if (argv[0] !== undefined && base(argv[0]) === "vibest") return argv.slice(1)
  return vibest.every((p, i) => argv[i] === p) ? argv.slice(vibest.length) : undefined
}

const RUNTIME_CONTROL = new Set(["agent", "pane", "tab", "workspace", "worktree", "server", "session"])
const USER_MACHINE_COMMANDS = new Set(["connect", "machine"])
const firstWord = (words: ReadonlyArray<string>) => words.find((w) => !w.startsWith("-")) ?? ""

const loadedRuntimePrograms = Effect.flatMap(Runtimes.Service, (runtimes) =>
  Effect.map(runtimes.all, (all) => new Set(all.map((runtime) => runtime.id))),
)

export const shellBlock = (
  command: string,
  vibest: ReadonlyArray<string>,
  runtimePrograms: ReadonlySet<string> = new Set(),
): string | undefined => {
  for (const p of programsOf(command)) {
    const [program = "", ...rest] = p.argv
    const name = base(program)
    if (runtimePrograms.has(name) && RUNTIME_CONTROL.has(firstWord(rest)))
      return "Agents must not control a terminal runtime's agents, panes, tabs, workspaces or worktrees; vibest manages them."
    const args = vibestArgs(vibest, p.argv)
    if (args === undefined) continue
    if (p.identity)
      return "vibest runs with the agent's own VIBEST_SESSION_ID; a command that changes or clears it is refused."
    const words = args.slice(0, args.includes("--") ? args.indexOf("--") : undefined)
    if (USER_MACHINE_COMMANDS.has(firstWord(words)))
      return `vibest ${firstWord(words)} manages connections between machines; only the user runs it.`
    const at = words.indexOf("integration")
    if (at !== -1 && words[at + 1] === "stop")
      return "vibest integration stop is the harness's execution-end hook, not an agent command."
    if (at !== -1 && words[at + 1] === "prompt")
      return "vibest integration prompt is the harness's user-prompt hook, not an agent command."
    if (at !== -1 && words[at + 1] === "ready")
      return "vibest integration ready is the harness's session-start hook, not an agent command."
  }
  return undefined
}

const programsArgv = (command: string): ReadonlyArray<ReadonlyArray<string>> =>
  programsOf(command)
    .map((p) => p.argv)
    .filter((argv) => argv.length > 0)

const physical = (
  p: string,
  seen?: ReadonlySet<string>,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const key = path.resolve(p)
    if (seen?.has(key)) return Option.none<string>()
    const visited = new Set(seen).add(key)
    let current = path.parse(p).root
    const parts = p.split(path.sep)
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!
      if (segment === "" || segment === ".") continue
      if (segment === "..") {
        current = path.dirname(current)
        continue
      }
      const joined = path.join(current, segment)
      const resolved = yield* fs.realPath(joined).pipe(Effect.option)
      if (Option.isSome(resolved)) {
        current = resolved.value
        continue
      }
      const isLastSegment = !parts.slice(i + 1).some((s) => s !== "" && s !== ".")
      if (!isLastSegment) {
        current = joined
        continue
      }
      const link = yield* fs.readLink(joined).pipe(
        Effect.map((target): { readonly target: string } | undefined => ({ target })),
        Effect.catchTag("PlatformError", (e) => {
          const code = (e.reason.cause as { code?: unknown } | undefined)?.code
          const notALink =
            e.reason._tag === "NotFound" || code === "EINVAL" || code === "ENOTDIR" || code === "ENAMETOOLONG"
          return notALink ? Effect.succeed(undefined) : Effect.succeed("refuse" as const)
        }),
      )
      if (link === "refuse" || link?.target === "") return Option.none<string>()
      if (link !== undefined) {
        const target = path.isAbsolute(link.target) ? link.target : path.resolve(current, link.target)
        return yield* physical(target, visited)
      }
      current = joined
    }
    return Option.some(current)
  })

const str = (value: unknown) => (typeof value === "string" ? value : undefined)

export const toolPath = (raw: string, base: string, home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    let p = raw
    if (p.startsWith("file://")) {
      const fromUrl = yield* Effect.try(() => new URL(p)).pipe(Effect.flatMap(path.fromFileUrl), Effect.option)
      if (Option.isNone(fromUrl) || fromUrl.value === "") return undefined
      p = fromUrl.value
    }
    p = p.replace(/^~(?=$|\/)/, home)
    return path.isAbsolute(p) ? p : `${base}${path.sep}${p}`
  })

const inside = (p: string, dir: string, sep: string) => p === dir || p.startsWith(dir + sep)

const physicalOption = (p: string) => Effect.map(physical(p), Option.getOrUndefined)

const UNRESOLVED_LINK = "The path is a symlink that refers to itself or whose target cannot be read; refused."
const BAD_URL = "The call names a file URL vibest cannot read; refused."

const targetsOf = (
  raw: string,
  cwd: string,
): Effect.Effect<
  ReadonlyArray<string> | typeof UNRESOLVED_LINK | undefined,
  Config.ConfigError,
  Path.Path | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const p = yield* toolPath(raw, cwd, yield* Config.String("HOME"))
    if (p === undefined) return undefined
    const [followed, normalized] = yield* Effect.all([physical(p), physical(path.normalize(p))])
    if (Option.isNone(followed) || Option.isNone(normalized)) return UNRESOLVED_LINK
    return [followed.value, normalized.value]
  })

const pathArgs = (input: ToolCall["input"]) =>
  [str(input.file_path), str(input.notebook_path), str(input.path)].filter((p): p is string => !!p)

const OFF_LIMITS =
  "The projects directory is off limits to sessions, except this project's folder (VIBEST_PROJECT_DIR)."

const SHELL_WORDS = /[^\s'"`;|&()<>=,]+/g
const SHELL_SEARCH = /(?:^|[\s;&|(])(?:rg|ag|ack|grep|egrep|find|fd|tree|du)\s/

const floor = Effect.fn("Guard.floor")(function* (call: ToolCall, projectFolder: string | undefined) {
  const path = yield* Path.Path
  const layout = yield* Layout
  const projects = yield* physicalOption(layout.projects)
  const vibestHome = yield* physicalOption(layout.home)
  if (projects === undefined || vibestHome === undefined) return OFF_LIMITS
  const inOwn = (target: string) => projectFolder !== undefined && inside(target, projectFolder, path.sep)
  const resolve = (raw: string) => targetsOf(raw, call.cwd)
  const blocked = (target: string, search: boolean) =>
    (search && inside(projects, target, path.sep)) || (inside(target, projects, path.sep) && !inOwn(target))
  const tool = call.tool.toLowerCase()

  if (SHELL_TOOLS.has(tool)) {
    const command = shellCommand(call.input)
    if (command === undefined) return "The shell call has no command string; refused."
    const reason = shellBlock(command, yield* VibestCommand, yield* loadedRuntimePrograms)
    if (reason) return reason
    const search = SHELL_SEARCH.test(command)
    const cwd = yield* physicalOption(call.cwd)
    if (cwd === undefined || blocked(cwd, false)) return OFF_LIMITS
    for (const word of command.match(SHELL_WORDS) ?? []) {
      if (!word.includes("/") && !word.startsWith("~") && !word.includes(".vibest")) continue
      if (word.includes(".vibest") && /[*?[{$]/.test(word)) return OFF_LIMITS
      const targets = yield* resolve(word)
      if (targets === UNRESOLVED_LINK) return UNRESOLVED_LINK
      if (targets === undefined) return BAD_URL
      if (targets.some((t) => t === vibestHome || blocked(t, search))) return OFF_LIMITS
      if (word.includes(".vibest/projects") && !targets.every(inOwn)) return OFF_LIMITS
    }
    return undefined
  }
  if (!PATH_TOOLS.has(tool)) return undefined
  const search = SEARCH_TOOLS.has(tool)
  const globPathPrefix = tool === "glob" ? str(call.input.pattern)?.split(/[*?[{]/)[0] : undefined
  for (const raw of [...pathArgs(call.input), ...(globPathPrefix ? [globPathPrefix] : [])]) {
    const targets = yield* resolve(raw)
    if (targets === UNRESOLVED_LINK) return UNRESOLVED_LINK
    if (targets === undefined) return BAD_URL
    if (targets.some((t) => blocked(t, search))) return OFF_LIMITS
  }
  return undefined
})

const writesOf = Effect.fn("Guard.writesOf")(function* (call: ToolCall) {
  if (!fileWritingTool(call.tool)) return { writes: undefined }
  const writes: Array<string> = []
  for (const raw of pathArgs(call.input)) {
    const targets = yield* targetsOf(raw, call.cwd)
    if (targets === UNRESOLVED_LINK) return { refused: UNRESOLVED_LINK }
    if (targets === undefined) return { refused: BAD_URL }
    writes.push(...targets)
  }
  return { writes }
})

const decodePreToolUse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      tool_name: Schema.String,
      tool_input: Schema.Record(Schema.String, Schema.Unknown),
      cwd: Schema.optional(Schema.String),
      workspace_roots: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
)

export const check = (
  session: { readonly id: string; readonly agent: string; readonly projectDir: string },
  raw: string,
) =>
  Effect.gen(function* () {
    const input = yield* decodePreToolUse(raw)
    const path = yield* Path.Path
    const roots = input.workspace_roots ?? []
    const base = input.cwd || (roots.length === 1 ? roots[0] : undefined)
    if (!base || !path.isAbsolute(base))
      return yield* Effect.fail(new Error("the hook input has no absolute working directory"))
    const own = input.tool_input.cwd
    if (own !== undefined && typeof own !== "string")
      return yield* Effect.fail(new Error("tool_input.cwd is not a string"))
    const ownPath = own ? yield* toolPath(own, base, yield* Config.String("HOME")) : base
    if (ownPath === undefined) return yield* Effect.fail(new Error("tool_input.cwd is a file URL vibest cannot read"))
    const call: ToolCall = { tool: input.tool_name, input: input.tool_input, cwd: path.normalize(ownPath) }
    const projectFolder = yield* physicalOption(session.projectDir)
    const refused = yield* floor(call, projectFolder)
    if (refused) return refused
    const definition = (yield* Agents.Service).find(session.agent)
    if (definition === undefined)
      return `The agent definition ${session.agent} of session ${session.id} is not registered (its plugin is unloaded or failed to load); tool calls are refused.`
    const guard = definition.guard
    if (guard === undefined) return undefined
    const written = yield* writesOf(call)
    if ("refused" in written) return written.refused
    const guardCall: GuardCall = {
      ...call,
      programs: SHELL_TOOLS.has(call.tool.toLowerCase()) ? programsArgv(shellCommand(call.input) ?? "") : [],
      writes: written.writes,
      session: {
        id: session.id,
        projectFolder: projectFolder ?? "",
        harnessBinaries: new Set((yield* Harnesses.Service).all.map((harness) => harness.binary)),
        runtimePrograms: yield* loadedRuntimePrograms,
      },
    }
    return yield* Effect.try({
      try: () => guard(guardCall),
      catch: (error) => `The guard of agent ${definition.id} failed (${String(error)}); refused.`,
    }).pipe(Effect.catch((reason) => Effect.succeed(reason)))
  })
