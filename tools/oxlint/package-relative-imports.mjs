import path from "node:path"

const packageRoot = (file) => /^(.*\/packages\/(?:integration\/)?[^/]+)\/src\//.exec(file)?.[1]

export const packageRelativeImports = {
  create(context) {
    const file = context.filename.replaceAll("\\", "/")
    const root = packageRoot(file)
    if (root === undefined) return {}
    const check = (node) => {
      const source = node.source?.value
      if (typeof source !== "string" || !source.startsWith(".")) return
      if (path.posix.resolve(path.posix.dirname(file), source).startsWith(`${root}/`)) return
      context.report({
        node,
        message: "A relative import stays inside its own package: import another package by its @vibest name.",
      })
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    }
  },
}
