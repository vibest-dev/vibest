// Forbids eslint/oxlint disable comments on the import rules this repository treats as
// non-negotiable (the `node:` prefix and default imports for Node builtins), and blanket
// disables, which would turn them off too. Fix the import instead of silencing the diagnostic.
// oxlint accepts a rule name without its plugin prefix or under another plugin's prefix
// (prefer-node-protocol, node/prefer-node-protocol), so only the last segment is compared.

const DISABLE_DIRECTIVE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?:\s+(?<body>[\s\S]*))?$/u

const PROTECTED_RULES = new Set(["prefer-node-protocol", "node-import-style", "no-restricted-disable"])

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
            if (!PROTECTED_RULES.has(rule.split("/").pop())) continue
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

export { parseDisableDirective }
