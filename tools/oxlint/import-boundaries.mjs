const herdr = /^(effect-herdr-sdk|@vibest\/runtime-herdr)(\/|$)/
const bun = /^(@effect\/(platform|sql-sqlite)-bun(\/|$)|bun:)/

const boundaries = [
  {
    files: /\/packages\/(schema|core|server|protocol|client)\/src\//,
    banned: herdr,
    reason: "Runtime-neutral packages never depend on herdr.",
  },
  {
    files: /\/packages\/cli\/src\/[^/]+\.ts$/,
    banned: /^(@vibest\/core|effect-herdr-sdk)(\/|$)/,
    reason: "The CLI does only client work: it imports neither @vibest/core nor herdr.",
  },
  {
    files:
      /\/(packages\/(schema|core|protocol|server|client|integration\/claude|effect-herdr-sdk|effect-herdr-core-sdk)|tools\/verify)\/src\//,
    except: /\/platform\/|\/bun\.ts$/,
    banned: bun,
    reason: "Bun-specific imports belong in platform folders and bun.ts files.",
  },
]

export const importBoundaries = {
  create(context) {
    const file = context.filename.replaceAll("\\", "/")
    const applicable = boundaries.filter((b) => b.files.test(file) && !b.except?.test(file))
    if (applicable.length === 0) return {}

    const check = (node, source) => {
      if (typeof source !== "string") return
      for (const b of applicable)
        if (b.banned.test(source))
          context.report({ node, message: `Import of "${source}" is banned here. ${b.reason}` })
    }
    const declaration = (node) => check(node, node.source?.value)

    return {
      ImportDeclaration: declaration,
      ExportNamedDeclaration: declaration,
      ExportAllDeclaration: declaration,
      ImportExpression: (node) => check(node, node.source.value),
    }
  },
}
