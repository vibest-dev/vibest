const herdr = /^(effect-herdr-sdk|@vibest\/runtime-herdr)(\/|$)/
const bun = /^(@effect\/(platform|sql-sqlite)-bun(\/|$)|bun:)/
const cliBanned = /^(@vibest\/core|effect-herdr-sdk)(\/|$)/

const boundaries = [
  { files: /\/packages\/(schema|core|server|protocol|client)\/src\//, banned: [herdr, bun] },
  { files: /\/packages\/cli\/src\/[^/]+\.ts$/, banned: [cliBanned] },
  {
    files: /\/packages\/(integration\/claude|effect-herdr-sdk|effect-herdr-core-sdk)\/src\/|\/tools\/verify\/src\//,
    banned: [bun],
  },
]

const staticSpecifier = (node) => {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked
  return undefined
}

export const importBoundaries = {
  create(context) {
    const file = context.filename.replaceAll("\\", "/")
    const banned = boundaries.filter((b) => b.files.test(file) && !file.endsWith("/bun.ts")).flatMap((b) => b.banned)
    if (banned.length === 0) return {}

    const check = (node, specifier) => {
      const source = staticSpecifier(specifier)
      if (source !== undefined && banned.some((pattern) => pattern.test(source)))
        context.report({
          node,
          message: `Import of "${source}" is banned here (see no-restricted-imports in .oxlintrc.json).`,
        })
    }

    return {
      ImportExpression: (node) => check(node, node.source),
      TSImportType: (node) => check(node, node.argument?.literal ?? node.argument ?? node.source),
      TSExternalModuleReference: (node) => check(node, node.expression),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") check(node, node.arguments[0])
      },
    }
  },
}
