import fs from "node:fs"
import path from "node:path"

export type GoComment = { readonly line: number; readonly text: string }

const isAllowedDirective = (text: string, rest: string) =>
  text.startsWith("//go:") || text.startsWith("//nolint") || /^\s*import\s+"C"/.test(rest)

export const goComments = (source: string): Array<GoComment> => {
  const found: Array<GoComment> = []
  let line = 1
  let at = 0
  const skipQuoted = (quote: string) => {
    at++
    while (at < source.length && source[at] !== quote && source[at] !== "\n") {
      if (source[at] === "\\") at++
      at++
    }
    at++
  }
  while (at < source.length) {
    const c = source[at]
    if (c === "\n") {
      line++
      at++
    } else if (c === '"' || c === "'") {
      skipQuoted(c)
    } else if (c === "`") {
      const end = source.indexOf("`", at + 1)
      const stop = end === -1 ? source.length : end + 1
      line += source.slice(at, stop).split("\n").length - 1
      at = stop
    } else if (c === "/" && (source[at + 1] === "/" || source[at + 1] === "*")) {
      const block = source[at + 1] === "*"
      const end = block ? source.indexOf("*/", at + 2) : source.indexOf("\n", at)
      const stop = end === -1 ? source.length : block ? end + 2 : end
      const text = source.slice(at, stop)
      if (!isAllowedDirective(text, source.slice(stop))) found.push({ line, text })
      line += text.split("\n").length - 1
      at = stop
    } else {
      at++
    }
  }
  return found
}

const EXEMPT_DIRECTORIES = new Set(["third_party", "patches", "node_modules", ".mygo", "build", "out"])

const goFiles = (dir: string): Array<string> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return EXEMPT_DIRECTORIES.has(entry.name) ? [] : goFiles(full)
    return entry.name.endsWith(".go") ? [full] : []
  })

if (import.meta.main) {
  const roots = process.argv.slice(2)
  const failures = roots
    .flatMap(goFiles)
    .flatMap((file) =>
      goComments(fs.readFileSync(file, "utf8")).map(
        (comment) => `${file}:${comment.line}: ${comment.text.split("\n")[0]}`,
      ),
    )
  for (const failure of failures) console.error(failure)
  if (failures.length > 0) {
    console.error(
      'No comments in Go code: say it with a name, or move the explanation to docs. Allowed: //go: directives, //nolint, the cgo preamble before import "C".',
    )
    process.exit(1)
  }
}
