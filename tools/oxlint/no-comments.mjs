import { parseDisableDirective } from "./no-restricted-disable.mjs"

const TYPESCRIPT_DIRECTIVE = /^\s*@ts-(?:expect-error|ignore|nocheck|check)\b/u
const TRIPLE_SLASH_REFERENCE = /^\/\s*<reference\s/u
const ENABLE_DIRECTIVE = /^\s*(?:oxlint|eslint)-enable(?:\s|$)/u

export const isToolDirective = (comment) =>
  TYPESCRIPT_DIRECTIVE.test(comment.value.replace(/^\*+/u, "")) ||
  (comment.type === "Line" && TRIPLE_SLASH_REFERENCE.test(comment.value)) ||
  parseDisableDirective(comment.value) !== null ||
  ENABLE_DIRECTIVE.test(comment.value)

export const noComments = {
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang" || isToolDirective(comment)) continue
          context.report({
            node: comment,
            message:
              "No comments in code: say it with a name, or move the explanation to docs/design, docs/testing or .agents/rules.",
          })
        }
      },
    }
  },
}
