// Forbids eslint/oxlint disable comments on the import rules this repository treats as
// non-negotiable (the `node:` prefix and default imports for Node builtins), and blanket
// disables, which would turn them off too. Fix the import instead of silencing the diagnostic.

const DISABLE_DIRECTIVE = /^\s*(?<kind>oxlint|eslint)-disable(?<scope>-next-line|-line)?(?:\s+(?<body>[\s\S]*))?$/u

const PROTECTED_RULES = new Set([
  "unicorn/prefer-node-protocol",
  "vibest/node-import-style",
  "vibest/no-restricted-disable",
])

const isProtectedRule = (rule) => PROTECTED_RULES.has(rule)

const parseDisableDirective = (commentValue) => {
  const match = DISABLE_DIRECTIVE.exec(commentValue.trim())
  if (match?.groups === undefined) return null
  const rulePart = (match.groups.body ?? "").replace(/\s+--\s+[\s\S]*$/u, "").trim()
  if (rulePart === "") return { rules: null }
  const rules = rulePart
    .split(",")
    .map((part) => part.trim().split(/\s+/u)[0] ?? "")
    .filter((name) => name.length > 0)
  return { rules }
}

export const noRestrictedDisable = {
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const parsed = parseDisableDirective(comment.value)
          if (parsed === null) continue
          if (parsed.rules === null) {
            context.report({
              node: comment,
              message:
                "A blanket eslint/oxlint-disable also turns off the Node builtin import rules. Name the rules to disable.",
            })
            continue
          }
          for (const rule of parsed.rules) {
            if (!isProtectedRule(rule)) continue
            context.report({
              node: comment,
              message: `Do not disable ${rule} with a comment. Fix the import instead of silencing the diagnostic.`,
            })
          }
        }
      },
    }
  },
}

export { isProtectedRule, parseDisableDirective }
