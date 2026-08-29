// Forbids eslint/oxlint disable comments on the React effect rules that
// `.agents/rules/frontend-state.md` treats as non-negotiable. Rewrite the
// effect (or the store) instead of silencing the diagnostic.

const DISABLE_DIRECTIVE =
  /^\s*(?<kind>oxlint|eslint)-disable(?<scope>-next-line|-line)?(?:\s+(?<body>[\s\S]*))?$/u;

const PROTECTED_RULES = new Set([
  "react/exhaustive-deps",
  "react-hooks/exhaustive-deps",
  "vibest/no-restricted-disable",
]);

const PROTECTED_PREFIXES = ["react-you-might-not-need-an-effect/"];

const isProtectedRule = (rule) =>
  PROTECTED_RULES.has(rule) || PROTECTED_PREFIXES.some((prefix) => rule.startsWith(prefix));

const parseDisableDirective = (commentValue) => {
  const match = DISABLE_DIRECTIVE.exec(commentValue.trim());
  if (match?.groups === undefined) return null;
  const rulePart = (match.groups.body ?? "").replace(/\s+--\s+[\s\S]*$/u, "").trim();
  if (rulePart === "") return { rules: null };
  const rules = rulePart
    .split(",")
    .map((part) => part.trim().split(/\s+/u)[0] ?? "")
    .filter((name) => name.length > 0);
  return { rules };
};

export const noRestrictedDisable = {
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const parsed = parseDisableDirective(comment.value);
          if (parsed === null) continue;
          if (parsed.rules === null) {
            context.report({
              node: comment,
              message:
                "A blanket eslint/oxlint-disable also turns off react-you-might-not-need-an-effect and react/exhaustive-deps. Name the other rules, or rewrite the React effect.",
            });
            continue;
          }
          for (const rule of parsed.rules) {
            if (!isProtectedRule(rule)) continue;
            context.report({
              node: comment,
              message: `Do not disable ${rule} with a comment. Rewrite the effect (or the store) instead of silencing the diagnostic.`,
            });
          }
        }
      },
    };
  },
};

export { isProtectedRule, parseDisableDirective };
