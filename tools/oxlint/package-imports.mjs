import path from "node:path"

const allowed = {
  schema: [],
  plugin: ["@vibest/schema"],
  protocol: ["@vibest/schema"],
  client: ["@vibest/schema", "@vibest/protocol"],
  core: ["@vibest/schema", "@vibest/plugin"],
  server: ["@vibest/schema", "@vibest/plugin", "@vibest/core", "@vibest/protocol", "@vibest/client"],
  "platform-bun": [
    "@vibest/schema",
    "@vibest/plugin",
    "@vibest/core",
    "@vibest/client",
    "@vibest/server",
    "@vibest/builtins",
    "effect-herdr-sdk",
  ],
  builtins: ["@vibest/plugin", "@vibest/plugin-harnesses", "@vibest/runtime-herdr", "@vibest/runtime-herdr-core"],
  cli: [
    "@vibest/schema",
    "@vibest/protocol",
    "@vibest/client",
    "@vibest/builtins",
    "=@vibest/server/daemon",
    "#platform",
  ],
  "plugin-harnesses": ["@vibest/plugin", "@vibest/schema"],
  "runtime-herdr-core": ["@vibest/plugin", "@vibest/schema", "effect-herdr-core-sdk"],
  "runtime-herdr": ["@vibest/plugin", "@vibest/schema", "@vibest/protocol", "@vibest/client", "effect-herdr-sdk"],
  "integration/claude": ["@vibest/schema", "@vibest/protocol"],
  "integration/pi": ["@vibest/schema", "@vibest/protocol", "@vibest/client"],
  "integration/cursor": [],
  "effect-herdr-sdk": [],
  "effect-herdr-core-sdk": [],
  "tools/verify": [],
}

const handoff = {
  file: "/packages/cli/src/commands/handlers/daemon/default.ts",
  source: "@vibest/server/server",
  name: "HANDOFF_ENV",
}

const isWorkspace = (source) => /^(@vibest\/|effect-herdr-|#)/.test(source)
const permits = (entry, source) =>
  entry.startsWith("=") ? source === entry.slice(1) : source === entry || source.startsWith(`${entry}/`)

const isHandoff = (file, node, source) =>
  file.endsWith(handoff.file) &&
  source === handoff.source &&
  node.type === "ImportDeclaration" &&
  node.importKind !== "type" &&
  node.specifiers.length === 1 &&
  node.specifiers[0].type === "ImportSpecifier" &&
  node.specifiers[0].imported.name === handoff.name

export const packageImports = {
  create(context) {
    const file = context.filename.replaceAll("\\", "/")
    const match = /^(.*\/(?:packages\/((?:integration\/)?[^/]+)|(tools\/verify)))\/src\//.exec(file)
    if (match === null) return {}
    const [, root, packageName, tool] = match
    const name = packageName ?? tool
    const list = allowed[name]
    if (list === undefined) return {}
    const check = (node) => {
      const source = node.source?.value
      if (typeof source !== "string") return
      if (source.startsWith(".")) {
        if (path.posix.resolve(path.posix.dirname(file), source).startsWith(`${root}/`)) return
        context.report({ node, message: `A relative import stays inside ${name}: import another package by its name.` })
        return
      }
      if (!isWorkspace(source) || list.some((entry) => permits(entry, source)) || isHandoff(file, node, source)) return
      const names = list.map((entry) => entry.replace(/^=/, ""))
      context.report({
        node,
        message: `${name} imports ${names.length === 0 ? "no workspace package" : `only ${names.join(", ")}`}, not ${source} (architecture §2).`,
      })
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      TSImportType: check,
    }
  },
}
