import module from "node:module"

import { noComments } from "./no-comments.mjs"
import { noRestrictedDisable } from "./no-restricted-disable.mjs"

const { isBuiltin } = module

const bareName = (source) => source.replace(/^node:/, "")
const camelize = (s) => s.replace(/[/_](\w)/g, (_, c) => c.toUpperCase())
const firstSegment = (source) => bareName(source).split("/")[0]

const canonicalNames = (declarations) => {
  const byFirst = new Map()
  for (const d of declarations) {
    const first = firstSegment(d.source)
    if (!byFirst.has(first)) byFirst.set(first, new Set())
    byFirst.get(first).add(bareName(d.source))
  }
  return (source) => {
    const bare = bareName(source)
    const first = firstSegment(source)
    const contested = byFirst.get(first).size > 1 && bare !== first
    return camelize(contested ? bare : first)
  }
}

const nodeImportStyle = {
  create(context) {
    const declarations = []

    const reexport = (node) => {
      const source = node.source?.value
      if (typeof source !== "string" || !isBuiltin(source) || node.exportKind === "type") return
      if (node.specifiers?.length > 0 && node.specifiers.every((s) => s.exportKind === "type")) return
      context.report({
        node,
        message: `Do not re-export from Node builtins: import ${camelize(firstSegment(source))} from "node:${bareName(source)}" where it is used.`,
      })
    }

    return {
      ImportDeclaration(node) {
        const source = node.source.value
        if (typeof source !== "string" || !isBuiltin(source)) return
        if (node.importKind === "type") return

        declarations.push({ source, node })

        const short = camelize(firstSegment(source))
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") {
            context.report({
              node: specifier,
              message: `Use a default import for Node builtins: import ${short} from "node:${bareName(source)}", then call ${short}.<member> at the use site.`,
            })
          } else if (specifier.type === "ImportNamespaceSpecifier") {
            context.report({
              node: specifier,
              message: `Use a default import for Node builtins, not a namespace import: import ${short} from "node:${bareName(source)}".`,
            })
          }
        }
      },

      ExportNamedDeclaration: reexport,
      ExportAllDeclaration: reexport,

      "Program:exit"() {
        const expectedFor = canonicalNames(declarations)
        for (const { source, node } of declarations) {
          const def = node.specifiers.find((s) => s.type === "ImportDefaultSpecifier")
          if (!def) continue
          const expected = expectedFor(source)
          if (def.local.name !== expected) {
            context.report({
              node: def,
              message: `Import "${source}" under its canonical name: import ${expected} from "node:${bareName(source)}".`,
            })
          }
        }
      },
    }
  },
}

export default {
  meta: { name: "vibest" },
  rules: {
    "node-import-style": nodeImportStyle,
    "no-restricted-disable": noRestrictedDisable,
    "no-comments": noComments,
  },
}
