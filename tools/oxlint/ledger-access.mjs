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

const eventTable = /\b(FROM|JOIN) event\b/
const position = /\bposition\b/
const ledgerFiles = ["/packages/core/src/journal.ts", "/packages/core/src/db-schema.ts"]

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

const writeStatement = /INSERT INTO|UPDATE |DELETE FROM|sql\.insert\(|sql\.update\(/
const projectorWrites = textRule({
  matches: (text) => writeStatement.test(text),
  exempt: [
    "/packages/core/src/journal.ts",
    "/packages/core/src/projectors.ts",
    "/packages/core/src/db-schema.ts",
    "/packages/core/src/import/",
    "/packages/core/src/database/",
    "/packages/core/src/db.ts",
  ],
  message: "Only the journal, the projectors, the schema, migrations and the import write tables.",
})

const loopFiles = ["/packages/core/src/", "/packages/server/src/"]
const approvedLoops = ["/packages/core/src/update-check.ts", "/packages/core/src/plugin-supervisor.ts"]
const boundedRepeat = /\b(until|while|times)\b/
const member = (node, object, property) =>
  node?.type === "MemberExpression" && node.object.name === object && node.property.name === property

const noBackgroundLoop = {
  create(context) {
    const file = normalized(context)
    if (
      !isSource(file) ||
      !loopFiles.some((part) => file.includes(part)) ||
      approvedLoops.some((part) => file.endsWith(part))
    )
      return {}
    const report = (node, shape) =>
      context.report({ node, message: `No background loop (${shape}): vibestd does nothing between events.` })
    return {
      MemberExpression(node) {
        if (member(node, "Effect", "forever")) report(node, "Effect.forever")
        if (member(node, "Stream", "tick")) report(node, "Stream.tick")
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "setInterval") report(node, "setInterval")
        if (member(node.callee, "Effect", "schedule")) report(node, "Effect.schedule")
        if (member(node.callee, "Effect", "repeat") && !boundedRepeat.test(context.sourceCode.getText(node)))
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
