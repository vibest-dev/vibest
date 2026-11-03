// The built-in integrations' tool vocabulary (Claude Code, Pi, Cursor), turned into the neutral ToolCall the guard reads.
// Each integration calls this on its own side; the guard itself knows no tool names. No dependencies: the Claude plugin
// bundles it. A plugin harness maps its own tools.
import type { ToolCall } from "./protocol.ts"

const KINDS: Readonly<Record<string, ToolCall["kind"]>> = {
  bash: "shell",
  shell: "shell",
  powershell: "shell",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  strreplace: "edit",
  delete: "edit",
  read: "read",
  notebookread: "read",
  ls: "read",
  list: "read",
  readlints: "read",
  grep: "search",
  glob: "search",
  find: "search",
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined)

/** `name` (any case) with its arguments, at `cwd`, as a ToolCall: unknown tools are `other`. */
export const toolCallOf = (name: string, input: Readonly<Record<string, unknown>>, cwd: string): ToolCall => {
  const kind = KINDS[name.toLowerCase()] ?? "other"
  // A Glob pattern may itself be a path: its part before the first wildcard.
  const pattern = name.toLowerCase() === "glob" ? str(input.pattern)?.split(/[*?[{]/)[0] : undefined
  const paths = [str(input.file_path), str(input.notebook_path), str(input.path), pattern].filter(
    (p): p is string => p !== undefined && p !== "",
  )
  const command = str(input.command)
  return { kind, name, ...(command === undefined ? {} : { command }), paths, cwd }
}

/**
 * A usage-limit error, as the built-in CLIs word it: a limit code (`rate_limit`) or the provider's own limit text
 * (`usage limit`, `too many requests`) before the first colon. An integration reports such a turn end as
 * `failure.kind: "limited"`.
 */
export const isUsageLimitError = (error: string | undefined) => {
  const head = error?.split(":")[0]
  return head !== undefined && head !== "" && /rate[_ -]?limits?\b|usage limits?\b|too many requests/i.test(head)
}
