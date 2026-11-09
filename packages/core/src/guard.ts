import { Config, Effect, FileSystem, Option, Path, Schema } from "effect"

import { Harnesses } from "./harness.ts"
import { Layout, VibestCommand } from "./paths.ts"

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

const IDENTITY = /^VIBEST_(?:SESSION_ID|AGENT)(?:=|$)/
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

const HERDR_CONTROL = new Set(["agent", "pane", "tab", "workspace", "worktree", "server", "session"])
const GH_UNSAFE = new Set(["alias", "extension", "ext", "config", "auth"])
const firstWord = (words: ReadonlyArray<string>) => words.find((w) => !w.startsWith("-")) ?? ""

export const shellBlock = (
  command: string,
  vibest: ReadonlyArray<string>,
  coordinator: boolean,
  harnessClis: ReadonlySet<string> = new Set(),
): string | undefined => {
  for (const p of programsOf(command)) {
    const [program = "", ...rest] = p.argv
    const name = base(program)
    if (name === "herdr" && HERDR_CONTROL.has(firstWord(rest)))
      return "Agents must not control herdr agents, panes, tabs, workspaces or worktrees; vibest manages them."
    if (name === "herdr" && !coordinator) return "Sessions do not run herdr; vibest manages it."
    if (coordinator && harnessClis.has(name))
      return `The coordinator does not start ${name} itself: it would inherit the coordinator's identity and report its turns as the coordinator's. Start agents with vibest run.`
    if (coordinator && name === "gh" && GH_UNSAFE.has(firstWord(rest)))
      return `gh ${firstWord(rest)} changes gh's credentials or what it runs; ask the user to.`
    const args = vibestArgs(vibest, p.argv)
    if (args === undefined) continue
    if (p.identity)
      return "vibest runs with the agent's own VIBEST_SESSION_ID and VIBEST_AGENT; a command that changes or clears them is refused."
    const words = args.slice(0, args.includes("--") ? args.indexOf("--") : undefined)
    const at = words.indexOf("integration")
    if (at !== -1 && words[at + 1] === "stop")
      return "vibest integration stop is the harness's turn-end hook, not an agent command."
    if (at !== -1 && words[at + 1] === "prompt")
      return "vibest integration prompt is the harness's user-prompt hook, not an agent command."
    if (at !== -1 && words[at + 1] === "ready")
      return "vibest integration ready is the harness's session-start hook, not an agent command."
  }
  return undefined
}

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

export type Rules = (
  call: ToolCall,
) => Effect.Effect<string | undefined, Config.ConfigError, Layout | Path.Path | FileSystem.FileSystem | Harnesses>

const inside = (p: string, dir: string, sep: string) => p === dir || p.startsWith(dir + sep)

const projectDir = Effect.gen(function* () {
  const own = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_PROJECT_DIR")))
  return own ? Option.getOrUndefined(yield* physical(own)) : undefined
})

const UNRESOLVED_LINK = "The path is a symlink that refers to itself or whose target cannot be read; refused."

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

const COORDINATOR_EDITS =
  "The coordinator edits files only in the project folder (VIBEST_PROJECT_DIR); hand other changes to a session."

export const coordinator: Rules = (call) =>
  Effect.gen(function* () {
    const tool = call.tool.toLowerCase()
    if (SHELL_TOOLS.has(tool)) {
      const command = shellCommand(call.input)
      if (command === undefined) return "The shell call has no command string; refused."
      const clis = new Set((yield* Harnesses).all.map((definition) => definition.binary))
      return shellBlock(command, yield* VibestCommand, true, clis)
    }
    if (!fileWritingTool(call.tool)) return undefined
    const own = yield* projectDir
    const raws = pathArgs(call.input)
    if (own === undefined || raws.length === 0) return COORDINATOR_EDITS
    const sep = (yield* Path.Path).sep
    for (const raw of raws) {
      const targets = yield* targetsOf(raw, call.cwd)
      if (targets === UNRESOLVED_LINK) return UNRESOLVED_LINK
      if (targets === undefined || !targets.every((t) => inside(t, own, sep))) return COORDINATOR_EDITS
    }
    return undefined
  })

const OFF_LIMITS =
  "The projects directory is off limits to sessions, except this project's folder (VIBEST_PROJECT_DIR)."

const SHELL_WORDS = /[^\s'"`;|&()<>=,]+/g
const SHELL_SEARCH = /(?:^|[\s;&|(])(?:rg|ag|ack|grep|egrep|find|fd|tree|du)\s/

export const session: Rules = Effect.fn("Guard.session")(function* (call: ToolCall) {
  const path = yield* Path.Path
  const layout = yield* Layout
  const projectsOpt = yield* physical(layout.projects)
  const homeOpt = yield* physical(layout.home)
  if (Option.isNone(projectsOpt) || Option.isNone(homeOpt)) return OFF_LIMITS
  const projects = projectsOpt.value
  const vibestHome = homeOpt.value
  const own = yield* projectDir
  const inOwn = (target: string) => own !== undefined && inside(target, own, path.sep)
  const resolve = (raw: string) => targetsOf(raw, call.cwd)
  const BAD_URL = "The call names a file URL vibest cannot read; refused."
  const blocked = (target: string, search: boolean) =>
    (search && inside(projects, target, path.sep)) || (inside(target, projects, path.sep) && !inOwn(target))
  const tool = call.tool.toLowerCase()

  if (SHELL_TOOLS.has(tool)) {
    const command = shellCommand(call.input)
    if (command === undefined) return "The shell call has no command string; refused."
    const reason = shellBlock(command, yield* VibestCommand, false)
    if (reason) return reason
    const search = SHELL_SEARCH.test(command)
    const cwd = yield* physical(call.cwd)
    if (Option.isNone(cwd) || blocked(cwd.value, false)) return OFF_LIMITS
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

export const COORDINATOR = "coordinator"
export const GENERAL = "general"

export const rulesOf = (agent: string): Rules => (agent === COORDINATOR ? coordinator : session)

export const check = (agent: string, raw: string) =>
  Effect.gen(function* () {
    const rules = rulesOf(agent)
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
    const cwd = path.normalize(ownPath)
    return yield* rules({ tool: input.tool_name, input: input.tool_input, cwd })
  })
