import module from "node:module";

const { isBuiltin } = module;

// Enforces the repo convention for Node builtin imports:
//   import fs from "node:fs/promises"
// i.e. a lone default import, with call sites using property access
// (fs.rename(...)) — named and namespace specifiers are rejected. The `node:`
// prefix itself is `unicorn/prefer-node-protocol`'s job. Type-only imports are
// exempt: types have no runtime binding.
const nodeImportStyle = {
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string" || !isBuiltin(source)) return;
        if (node.importKind === "type") return;

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") {
            context.report({
              node: specifier,
              message: `Use a default import for Node builtins: import ${shortName(source)} from "node:${bareName(source)}", then call ${shortName(source)}.<member> at the use site.`,
            });
          } else if (specifier.type === "ImportNamespaceSpecifier") {
            context.report({
              node: specifier,
              message: `Use a default import for Node builtins, not a namespace import: import ${shortName(source)} from "node:${bareName(source)}".`,
            });
          }
        }
      },
    };
  },
};

function bareName(source) {
  return source.startsWith("node:") ? source.slice(5) : source;
}

// "node:fs/promises" -> "fs", "node:child_process" -> "childProcess"
function shortName(source) {
  const base = bareName(source).split("/")[0];
  return base.replace(/_(\w)/g, (_, c) => c.toUpperCase());
}

export default {
  meta: { name: "vibest" },
  rules: {
    "node-import-style": nodeImportStyle,
  },
};
