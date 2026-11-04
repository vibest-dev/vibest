// The tool-call rules every harness's pre-tool hook applies, one set per agent (VIBEST_AGENT): Claude's plugin tool.call
// (in PreToolUse's shape) and Cursor's preToolUse through `vibest integration guard`, Pi's tool_call in process. A call is allowed unless a rule here
// names it. Every agent: no herdr control (a session: no herdr at all), no vibest with its identity variables changed, no vibest turn-end bridge. The
// coordinator also does not edit files outside its project folder (VIBEST_PROJECT_DIR), start harness CLIs or run gh's
// credential and config commands. Any other session may not touch the projects directory except its own project folder
// (VIBEST_PROJECT_DIR): not another project's, for every harness. Which vibest commands an agent may run is
// vibest's own check where they run (cli.ts userOnly, server.ts ACCESS), not this one.
// These are checks on what a tool call says, not a sandbox: a shell command can reach a path or program no rule here
// recognizes, and a hook that times out lets the call through (the harness decides). The harness's own sandbox is the boundary (SPEC §13).
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect"

import { Layout, VibestCommand } from "./paths.ts"

/** A tool call as the harness reports it: its tool name (any case), its arguments, and the agent's cwd. */
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
/** Path tools that read a whole tree: given a directory above the project, they reach into it. */
const SEARCH_TOOLS = new Set(["grep", "glob", "find"])
const EDIT_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"])
/** Cursor's file writes, which the coordinator's harnesses do not use. Same refusal. */
const fileWritingTool = (tool: string) => {
  const name = tool.toLowerCase()
  return EDIT_TOOLS.has(name) || name === "delete" || name === "strreplace"
}
/** Cursor's is Shell `{command, cwd}`. */
const SHELL_TOOLS = new Set(["bash", "powershell", "shell"])
const shellCommand = (input: Readonly<Record<string, unknown>>) => str(input.command)

/** The `)` closing the `(` at `open`, or -1. ponytail: quotes inside are not followed, so a quoted `)` ends it early. */
const closing = (s: string, open: number) => {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++
    else if (s[i] === ")" && --depth === 0) return i
  }
  return -1
}

/**
 * The simple commands a shell command runs, best effort: split at unquoted `|`, `&`, `;`, `(`, `)` and newlines, with
 * redirection targets, comments and here-document bodies left out, and the commands inside `$(…)` and backquotes added
 * after the rest. A quoted string is one word, never a command. Not a shell: variables, aliases and functions are not expanded.
 */
export const splitCommand = (command: string): ReadonlyArray<ReadonlyArray<string>> => {
  const commands: Array<Array<string>> = [[]]
  const nested: Array<string> = []
  const heredocs: Array<string> = []
  let word: string | undefined
  let quote: "'" | '"' | undefined
  // The next word is a redirection's file, not an argument.
  let target = false
  const end = () => {
    if (word !== undefined && target) target = false
    else if (word !== undefined) commands.at(-1)!.push(word)
    word = undefined
  }
  const next = () => {
    end()
    target = false
    commands.push([])
  }
  const s = command
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote === "'") {
      if (c === "'") quote = undefined
      else word = (word ?? "") + c
    } else if (c === "`" || (c === "$" && s[i + 1] === "(")) {
      const close = c === "`" ? s.indexOf("`", i + 1) : closing(s, i + 1)
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
      // Here-document bodies are data: each runs to its delimiter line.
      for (const delimiter of heredocs.splice(0)) {
        while (i < s.length) {
          const eol = s.indexOf("\n", i + 1)
          const line = s.slice(i + 1, eol === -1 ? s.length : eol)
          i = eol === -1 ? s.length : eol
          if (line.replace(/^\t+/, "").replace(/\r$/, "") === delimiter) break
        }
      }
    } else if (c === "<" || c === ">") {
      // `2>&1`: the descriptor is not a word either.
      if (word !== undefined && /^\d+$/.test(word)) word = undefined
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
        target = true
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

/** VIBEST_SESSION_ID and VIBEST_AGENT, the variables vibest's caller identity comes from (cli.ts `caller`). */
const IDENTITY = /^VIBEST_(?:SESSION_ID|AGENT)(?:=|$)/
const base = (word: string) => word.slice(word.lastIndexOf("/") + 1)
/** Programs that run the rest of their words as a command, each with its options that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlyArray<string>>> = {
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
/** Builtins that change a variable of the shell, exported ones included. */
const SETTERS = new Set(["unset", "export", "declare", "typeset", "readonly", "local"])

/** A program a shell command runs: its words, and whether the words before it change or clear vibest's identity variables. */
interface Program {
  readonly argv: ReadonlyArray<string>
  readonly identity: boolean
}

/** What a simple command runs: past `VAR=value`, wrappers (env, nohup, xargs, sudo…), into `sh -c '…'` and `eval`. */
const programs = (argv: ReadonlyArray<string>, identity = false): ReadonlyArray<Program> => {
  let i = 0
  for (;;) {
    const w = argv[i]
    // Only assignments: in a shell, `VIBEST_AGENT=` alone changes the exported value too.
    if (w === undefined) return identity ? [{ argv: [], identity }] : []
    const name = base(w)
    if (/^[A-Za-z_]\w*=/.test(w)) {
      identity ||= IDENTITY.test(w)
      i++
    } else if (KEYWORDS.has(w)) {
      i++
    } else if (Object.hasOwn(WRAPPERS, name)) {
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
        if (WRAPPERS[name]!.includes(o)) {
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

/** The programs `command` runs. An identity variable unset, exported or assigned anywhere in it counts for each of them. */
const programsOf = (command: string): ReadonlyArray<Program> => {
  const all = splitCommand(command).flatMap((argv) => programs(argv))
  const changed = all.some(
    (p) => p.argv.length === 0 || (SETTERS.has(p.argv[0]!) && p.argv.slice(1).some((w) => IDENTITY.test(w))),
  )
  return changed ? all.map((p) => ({ ...p, identity: true })) : all
}

/** The arguments after vibest when `argv` runs vibest: by name, by a path ending in /vibest, or as VIBEST_COMMAND spells it. */
const vibestArgs = (vibest: ReadonlyArray<string>, argv: ReadonlyArray<string>) => {
  if (argv[0] !== undefined && base(argv[0]) === "vibest") return argv.slice(1)
  return vibest.every((p, i) => argv[i] === p) ? argv.slice(vibest.length) : undefined
}

const HERDR_CONTROL = new Set(["agent", "pane", "tab", "workspace", "worktree", "server", "session"])
/** The harness CLIs vibest starts (each adapter's binary; guard.test checks the list). */
export const HARNESS_CLIS = new Set(["pi", "claude", "cursor-agent"])
const GH_UNSAFE = new Set(["alias", "extension", "ext", "config", "auth"])
const firstWord = (words: ReadonlyArray<string>) => words.find((w) => !w.startsWith("-")) ?? ""

/**
 * Reason an agent may not run this shell command, if any. Everything else runs, whatever program or shell syntax it
 * uses: an vibest command an agent may not run is refused by vibest itself (cli.ts userOnly, server.ts ACCESS).
 */
export const shellBlock = (
  command: string,
  vibest: ReadonlyArray<string>,
  coordinator: boolean,
): string | undefined => {
  for (const p of programsOf(command)) {
    const [program = "", ...rest] = p.argv
    const name = base(program)
    if (name === "herdr" && HERDR_CONTROL.has(firstWord(rest)))
      return "Agents must not control herdr agents, panes, tabs, workspaces or worktrees; vibest manages them."
    // A session runs no herdr at all (once Claude's `Bash(herdr:*)` deny); the coordinator may read herdr's help.
    if (name === "herdr" && !coordinator) return "Sessions do not run herdr; vibest manages it."
    if (coordinator && HARNESS_CLIS.has(name))
      return `The coordinator does not start ${name} itself: it would inherit the coordinator's identity and report its turns as the coordinator's. Start agents with vibest run.`
    if (coordinator && name === "gh" && GH_UNSAFE.has(firstWord(rest)))
      return `gh ${firstWord(rest)} changes gh's credentials or what it runs; ask the user to.`
    const args = vibestArgs(vibest, p.argv)
    if (args === undefined) continue
    // The caller's role is these variables (cli.ts `caller`): without them vibest would speak to vibestd as the user.
    if (p.identity)
      return "vibest runs with the agent's own VIBEST_SESSION_ID and VIBEST_AGENT; a command that changes or clears them is refused."
    // The harness's turn-end hook runs it; an agent running it would report a turn end that did not happen.
    const words = args.slice(0, args.includes("--") ? args.indexOf("--") : undefined)
    const at = words.indexOf("integration")
    if (at !== -1 && words[at + 1] === "stop")
      return "vibest integration stop is the harness's turn-end hook, not an agent command."
    if (at !== -1 && words[at + 1] === "prompt")
      return "vibest integration prompt is the harness's user-prompt hook, not an agent command."
  }
  return undefined
}

/**
 * Where an absolute path really leads: segment by segment, following each symlink that exists before applying a later
 * `..` (as the system does), so neither `artifacts/link/x` nor `<project>/../<other project>` hides where it goes.
 * A dangling symlink as the last segment has no real path, but a write creates its target, so that location is what
 * counts. None only when that segment is a link whose target cannot be read, or the link refers to itself.
 */
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
      // A later segment is not the file a write would create through this link.
      if (parts.slice(i + 1).some((s) => s !== "" && s !== ".")) {
        current = joined
        continue
      }
      const link = yield* fs.readLink(joined).pipe(
        Effect.map((target): { readonly target: string } | undefined => ({ target })),
        Effect.catchTag("PlatformError", (e) => {
          // Not a link, or not a path a link can be read from: judge the path as written.
          const code = (e.reason.cause as { code?: unknown } | undefined)?.code
          return e.reason._tag === "NotFound" || code === "EINVAL" || code === "ENOTDIR" || code === "ENAMETOOLONG"
            ? Effect.succeed(undefined)
            : Effect.succeed("refuse" as const)
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

/**
 * A path as Cursor's tools take it (cursor-agent's path-utils `o1`): a `file://` URL as its path (the URL standard parses
 * it, as node's fileURLToPath does: tabs and newlines dropped, `\` as `/`, `%2e%2e` as `..`), a leading `~` as HOME,
 * a relative path under `base`. Not normalized: `..` stays for `physical` to follow. Undefined for a file URL that does
 * not parse (Cursor would take it as a relative path).
 */
export const toolPath = (raw: string, base: string, home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    let p = raw
    if (p.startsWith("file://")) {
      const fromUrl = yield* Effect.try(() => new URL(p)).pipe(Effect.flatMap(path.fromFileUrl), Effect.option)
      // Bun answers some malformed encodings with "" where node throws.
      if (Option.isNone(fromUrl) || fromUrl.value === "") return undefined
      p = fromUrl.value
    }
    p = p.replace(/^~(?=$|\/)/, home)
    return path.isAbsolute(p) ? p : `${base}${path.sep}${p}`
  })

/** One agent's rules: the reason to refuse `call`, if any. */
export type Rules = (
  call: ToolCall,
) => Effect.Effect<string | undefined, Config.ConfigError, Layout | Path.Path | FileSystem.FileSystem>

const inside = (p: string, dir: string, sep: string) => p === dir || p.startsWith(dir + sep)

/** The physical path of the agent's project folder (VIBEST_PROJECT_DIR, which vibestd sets in its terminal), if set. */
const projectDir = Effect.gen(function* () {
  const own = Option.getOrUndefined(yield* Config.option(Config.String("VIBEST_PROJECT_DIR")))
  return own ? Option.getOrUndefined(yield* physical(own)) : undefined
})

/** A symlink that refers to itself, or whose target cannot be read. Not a bad file URL. */
const UNRESOLVED_LINK = "The path is a symlink that refers to itself or whose target cannot be read; refused."

/**
 * Where `raw` leads from `cwd` (`~` and file URLs expanded), both as the system follows it (symlinks before a later
 * `..`) and as a tool that normalizes the path first (Cursor's do). Undefined for a file URL that does not parse.
 * `UNRESOLVED_LINK` when a symlink's target cannot be read.
 */
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

/** The path arguments of a file tool call. */
const pathArgs = (input: ToolCall["input"]) =>
  [str(input.file_path), str(input.notebook_path), str(input.path)].filter((p): p is string => !!p)

const COORDINATOR_EDITS =
  "The coordinator edits files only in the project folder (VIBEST_PROJECT_DIR); hand other changes to a session."

/** The coordinator: the shared shell denials plus its own, and file edits only in its project folder (a session makes changes). */
export const coordinator: Rules = (call) =>
  Effect.gen(function* () {
    const tool = call.tool.toLowerCase()
    if (SHELL_TOOLS.has(tool)) {
      const command = shellCommand(call.input)
      if (command === undefined) return "The shell call has no command string; refused."
      return shellBlock(command, yield* VibestCommand, true)
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

/** Shell words that may stand for a path: a word, or the value of `--opt=value` / `VAR=value`. */
const SHELL_WORDS = /[^\s'"`;|&()<>=,]+/g
/** Programs that walk a directory tree: given a directory above the project, they reach into it. */
const SHELL_SEARCH = /(?:^|[\s;&|(])(?:rg|ag|ack|grep|egrep|find|fd|tree|du)\s/

/**
 * Every agent but the coordinator: the shared shell denials, and nothing under the projects directory but the session's own
 * project folder (VIBEST_PROJECT_DIR, which vibestd sets as it opens the session's terminal); without one, nothing there.
 */
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
  /** Off limits: inside the projects directory but not the session's project folder; with search, also a directory above it. */
  const blocked = (target: string, search: boolean) =>
    (search && inside(projects, target, path.sep)) || (inside(target, projects, path.sep) && !inOwn(target))
  const tool = call.tool.toLowerCase()

  if (SHELL_TOOLS.has(tool)) {
    const command = shellCommand(call.input)
    if (command === undefined) return "The shell call has no command string; refused."
    const reason = shellBlock(command, yield* VibestCommand, false)
    if (reason) return reason
    // A regex cannot sandbox a shell; this catches the project named directly, which is what an honest mistake looks like.
    const search = SHELL_SEARCH.test(command)
    // The shell starts in the project (a cwd the call chose): every bare file name is inside it.
    const cwd = yield* physical(call.cwd)
    if (Option.isNone(cwd) || blocked(cwd.value, false)) return OFF_LIMITS
    for (const word of command.match(SHELL_WORDS) ?? []) {
      if (!word.includes("/") && !word.startsWith("~") && !word.includes(".vibest")) continue
      // Globs and variables around vibest's home could expand to anything in it.
      if (word.includes(".vibest") && /[*?[{$]/.test(word)) return OFF_LIMITS
      const targets = yield* resolve(word)
      if (targets === UNRESOLVED_LINK) return UNRESOLVED_LINK
      if (targets === undefined) return BAD_URL
      // vibest's home itself: a later relative path (after cd) would be inside the Project.
      if (targets.some((t) => t === vibestHome || blocked(t, search))) return OFF_LIMITS
      // Relative to a directory an earlier `cd` moved to, which the hook does not see.
      if (word.includes(".vibest/projects") && !targets.every(inOwn)) return OFF_LIMITS
    }
    return undefined
  }
  if (!PATH_TOOLS.has(tool)) return undefined
  const search = SEARCH_TOOLS.has(tool)
  // A Glob pattern may itself be a path: its part before the first wildcard.
  const pattern = tool === "glob" ? str(call.input.pattern)?.split(/[*?[{]/)[0] : undefined
  for (const raw of [...pathArgs(call.input), ...(pattern ? [pattern] : [])]) {
    const targets = yield* resolve(raw)
    if (targets === UNRESOLVED_LINK) return UNRESOLVED_LINK
    if (targets === undefined) return BAD_URL
    if (targets.some((t) => blocked(t, search))) return OFF_LIMITS
  }
  return undefined
})

/**
 * The hook input in Claude's PreToolUse shape, which the Claude plugin's tool.call builds. Cursor's preToolUse has the same three, but its `cwd` may
 * be empty or left out (then its one workspace root) and a Shell call carries its own working directory in `tool_input.cwd`.
 */
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

/** The built-in agents: the main agent (`vibest`), and `general`, the agent every spawned session runs. */
export const COORDINATOR = "coordinator"
export const GENERAL = "general"

/** The rules of `agent` (VIBEST_AGENT): the coordinator's, or every other session's. */
export const rulesOf = (agent: string): Rules => (agent === COORDINATOR ? coordinator : session)

/**
 * The rules of `agent` (VIBEST_AGENT for `vibest integration guard`, the session's own for vibestd's HTTP guard) applied
 * to one pre-tool hook input (`raw`, as the harness sent it): the reason to refuse the call, if any; the harness adapter
 * words the answer. Any failure (input vibest cannot read) makes the hook refuse.
 */
export const check = (agent: string, raw: string) =>
  Effect.gen(function* () {
    const rules = rulesOf(agent)
    const input = yield* decodePreToolUse(raw)
    const path = yield* Path.Path
    // The base: the call's cwd, else the only workspace root; absolute, or vibest cannot tell where paths lead.
    const roots = input.workspace_roots ?? []
    const base = input.cwd || (roots.length === 1 ? roots[0] : undefined)
    if (!base || !path.isAbsolute(base))
      return yield* Effect.fail(new Error("the hook input has no absolute working directory"))
    // A Shell call's own directory, read the way Cursor reads it (empty: the default; then normalized, as Cursor's
    // path.resolve does); anything else malformed refuses.
    const own = input.tool_input.cwd
    if (own !== undefined && typeof own !== "string")
      return yield* Effect.fail(new Error("tool_input.cwd is not a string"))
    const ownPath = own ? yield* toolPath(own, base, yield* Config.String("HOME")) : base
    if (ownPath === undefined) return yield* Effect.fail(new Error("tool_input.cwd is a file URL vibest cannot read"))
    const cwd = path.normalize(ownPath)
    return yield* rules({ tool: input.tool_name, input: input.tool_input, cwd })
  })
