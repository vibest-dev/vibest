const isSource = (file) => /\/packages\/.+\/src\//.test(file) && !file.endsWith(".test.ts")
const normalized = (context) => context.filename.replaceAll("\\", "/")

const textRule = ({ matches, exempt, message }) => ({
  create(context) {
    const file = normalized(context)
    if (!isSource(file) || exempt.some((part) => file.includes(part))) return {}
    const check = (node, text) => {
      if (typeof text === "string" && matches(text)) context.report({ node, message })
    }
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    }
  },
})

const approvedOperations = (file, operations) => {
  const approved = operations.find((operation) => file.endsWith(operation.file))
  let used = 0
  return (text) => {
    if (approved === undefined || !approved.accepts(text) || used >= approved.count) return false
    used++
    return true
  }
}

const eventTable = /\b(FROM|JOIN) event\b/
const position = /\bposition\b/
const ledgerFiles = ["/packages/core/src/database/journal.ts", "/packages/core/src/database/db-schema.ts"]

const eventReads = {
  create(context) {
    const file = normalized(context)
    if (!isSource(file) || ledgerFiles.some((part) => file.endsWith(part))) return {}
    const message = "Only the journal reads the event table and its local position."
    const check = (node, text) => {
      if (typeof text === "string" && (eventTable.test(text) || position.test(text))) context.report({ node, message })
    }
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
      Identifier: (node) => check(node, node.name),
    }
  },
}

const noPayloadSql = textRule({
  matches: (text) => text.includes("json_extract"),
  exempt: ["/packages/core/src/import/"],
  message: "No query reads into a fact's payload; only the v1 import reads v1 event data.",
})

const writeStatement = /INSERT INTO|UPDATE |DELETE FROM/
const writers = [
  "/packages/core/src/database/journal.ts",
  "/packages/core/src/database/projectors.ts",
  "/packages/core/src/database/db-schema.ts",
  "/packages/core/src/import/",
  "/packages/core/src/database/migration",
]
const openingWrite = {
  file: "/packages/core/src/database/db.ts",
  count: 1,
  accepts: (text) => text.trim() === "UPDATE meta SET value = value WHERE key = ''",
}
const writeMessage = "Only the journal, the projectors, the schema, migrations and the import write tables."
const isSqlBuilder = (node) => node?.name === "sql" || node?.property?.name === "sql"

const projectorWrites = {
  create(context) {
    const file = normalized(context)
    if (!isSource(file) || writers.some((part) => file.includes(part))) return {}
    const approvedWrite = approvedOperations(file, [openingWrite])
    const check = (node, text) => {
      if (typeof text === "string" && writeStatement.test(text) && !approvedWrite(text))
        context.report({ node, message: writeMessage })
    }
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type === "MemberExpression" &&
          isSqlBuilder(callee.object) &&
          ["insert", "update"].includes(callee.property.name)
        )
          context.report({ node, message: writeMessage })
      },
    }
  },
}

const loopFiles = ["/packages/core/src/", "/packages/server/src/"]
const approvedLoops = [{ file: "/packages/core/src/plugin/supervisor.ts", kind: "Effect.forever", count: 1 }]
const boundedRepeat = /\b(until|while|times)\b/
const member = (node, object, property) =>
  node?.type === "MemberExpression" && node.object.name === object && node.property.name === property

const noBackgroundLoop = {
  create(context) {
    const file = normalized(context)
    if (!isSource(file) || !loopFiles.some((part) => file.includes(part))) return {}
    const used = {}
    const approved = (kind) => {
      const loop = approvedLoops.find((l) => file.endsWith(l.file) && l.kind === kind)
      used[kind] = (used[kind] ?? 0) + 1
      return loop !== undefined && used[kind] <= loop.count
    }
    const report = (node, shape) =>
      context.report({ node, message: `No background loop (${shape}): vibestd does nothing between events.` })
    return {
      Identifier(node) {
        if (node.name === "setInterval") report(node, "setInterval")
      },
      Literal(node) {
        if (node.value === "setInterval") report(node, "setInterval")
      },
      MemberExpression(node) {
        if (member(node, "Effect", "forever") && !approved("Effect.forever")) report(node, "Effect.forever")
        if (member(node, "Stream", "tick")) report(node, "Stream.tick")
      },
      CallExpression(node) {
        if (member(node.callee, "Effect", "schedule")) report(node, "Effect.schedule")
        if (
          member(node.callee, "Effect", "repeat") &&
          !boundedRepeat.test(context.sourceCode.getText(node)) &&
          !approved("Effect.repeat")
        )
          report(node, "Effect.repeat without until, while or times")
      },
    }
  },
}

export const ledgerAccessRules = {
  "event-reads": eventReads,
  "no-payload-sql": noPayloadSql,
  "projector-writes": projectorWrites,
  "no-background-loop": noBackgroundLoop,
}
