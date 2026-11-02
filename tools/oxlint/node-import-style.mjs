import module from "node:module";

import { noRestrictedDisable } from "./no-restricted-disable.mjs";

const { isBuiltin } = module;

// Enforces the repo convention for Node builtin imports:
//   import fs from "node:fs/promises"
// i.e. a lone default import bound to the module's canonical name, with call
// sites using property access (fs.rename(...)). Named and namespace specifiers
// are rejected; so are ad-hoc local names (nodePath, NodeAssert). The `node:`
// prefix itself is `unicorn/prefer-node-protocol`'s job. Type-only imports are
// exempt: types have no runtime binding.
//
// Canonical name: the module's first path segment, camelCased ("child_process"
// -> childProcess, "fs/promises" -> fs, "assert/strict" -> assert). Only when
// one file imports two builtins sharing a first segment (node:fs AND
// node:fs/promises) does the subpath import fall back to the full camelCased
// path (fsPromises).

const bareName = (source) => source.replace(/^node:/, "");
const camelize = (s) => s.replace(/[/_](\w)/g, (_, c) => c.toUpperCase());
const firstSegment = (source) => bareName(source).split("/")[0];

const canonicalNames = (declarations) => {
  const byFirst = new Map();
  for (const d of declarations) {
    const first = firstSegment(d.source);
    if (!byFirst.has(first)) byFirst.set(first, new Set());
    byFirst.get(first).add(bareName(d.source));
  }
  return (source) => {
    const bare = bareName(source);
    const first = firstSegment(source);
    const contested = byFirst.get(first).size > 1 && bare !== first;
    return camelize(contested ? bare : first);
  };
};

const nodeImportStyle = {
  create(context) {
    const declarations = [];

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string" || !isBuiltin(source)) return;
        if (node.importKind === "type") return;

        declarations.push({ source, node });

        const short = camelize(firstSegment(source));
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") {
            context.report({
              node: specifier,
              message: `Use a default import for Node builtins: import ${short} from "node:${bareName(source)}", then call ${short}.<member> at the use site.`,
            });
          } else if (specifier.type === "ImportNamespaceSpecifier") {
            context.report({
              node: specifier,
              message: `Use a default import for Node builtins, not a namespace import: import ${short} from "node:${bareName(source)}".`,
            });
          }
        }
      },

      "Program:exit"() {
        const expectedFor = canonicalNames(declarations);
        for (const { source, node } of declarations) {
          const def = node.specifiers.find((s) => s.type === "ImportDefaultSpecifier");
          if (!def) continue;
          const expected = expectedFor(source);
          if (def.local.name !== expected) {
            context.report({
              node: def,
              message: `Import "${source}" under its canonical name: import ${expected} from "node:${bareName(source)}".`,
            });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "vibest" },
  rules: {
    "node-import-style": nodeImportStyle,
    "no-restricted-disable": noRestrictedDisable,
  },
};
