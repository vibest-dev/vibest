import { Plugin, ToolRefused } from "@vibest/plugin/effect"
import { Effect, Predicate } from "effect"

const SHELL_TOOLS = new Set(["bash", "powershell", "shell"])
const FILE_DESCRIPTOR = /^\d+$/

const closingParenIgnoringQuotes = (s: string, open: number) => {
  let depth = 0

  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++
    else if (s[i] === ")" && --depth === 0) return i
  }

  return -1
}

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

const WRAPPER_VALUE_OPTIONS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["env", ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]],
  ["command", []],
  ["builtin", []],
  ["exec", ["-a"]],
  ["nohup", []],
  ["time", []],
  ["nice", ["-n"]],
  ["timeout", ["-s", "-k"]],
  ["sudo", ["-u", "-g", "-C", "-D", "-h", "-p", "-U", "-r", "-t"]],
  ["xargs", ["-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a"]],
])

const KEYWORDS = new Set(["!", "{", "if", "then", "elif", "else", "do", "while", "until"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const VARIABLE_SETTERS = new Set(["unset", "export", "declare", "typeset", "readonly", "local"])
const SOCKET_TOOLS = new Set(["curl", "nc", "ncat", "socat", "wget"])
const HOOK_SOCKET = /(?:^|[/:=])vibest-http\.sock$/

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
    } else if (WRAPPER_VALUE_OPTIONS.has(name)) {
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

        if (WRAPPER_VALUE_OPTIONS.get(name)!.includes(o)) {
          if (name === "env" && (o === "-u" || o === "--unset")) identity ||= IDENTITY.test(argv[i + 1] ?? "")

          if (name === "env" && (o === "-S" || o === "--split-string"))
            return programs([...splitCommand(argv[i + 1] ?? "").flat(), ...argv.slice(i + 2)], identity)
          i++
        } else if (name === "env" && o.startsWith("--split-string=")) {
          return programs([...splitCommand(o.slice("--split-string=".length)).flat(), ...argv.slice(i + 1)], identity)
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

const VIBEST_CLI_VAR = /^\$(?:VIBEST_CLI|\{VIBEST_CLI[^}]*\})$/

const isVibestProgram = (word: string) => base(word) === "vibest" || VIBEST_CLI_VAR.test(word)

const vibestArgs = (argv: ReadonlyArray<string>) =>
  argv[0] !== undefined && isVibestProgram(argv[0]) ? argv.slice(1) : undefined

export const shellRefusal = (command: string): string | undefined => {
  for (const p of programsOf(command)) {
    const args = vibestArgs(p.argv)

    if (args !== undefined) {
      if (p.identity)
        return "vibest runs with the agent's own VIBEST_SESSION_ID; a command that changes or clears it is refused."
      continue
    }

    if (
      p.argv[0] !== undefined &&
      SOCKET_TOOLS.has(base(p.argv[0])) &&
      p.argv.slice(1).some((a) => HOOK_SOCKET.test(a))
    )
      return "vibest-http.sock is the harness's hook socket, not for agent commands."
  }

  return undefined
}

export const guardPlugin = Plugin.define({
  id: "vibest.guard",
  effect: (ctx) =>
    ctx.session
      .hook("tool.execute.before", (event) => {
        if (!SHELL_TOOLS.has(event.tool.toLowerCase())) return Effect.void
        const command = Predicate.isString(event.input.command) ? event.input.command : undefined

        if (command === undefined) return Effect.void
        const reason = shellRefusal(command)

        return reason === undefined ? Effect.void : Effect.fail(new ToolRefused({ reason }))
      })
      .pipe(Effect.asVoid),
})
