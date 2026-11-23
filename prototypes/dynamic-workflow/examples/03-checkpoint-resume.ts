import { Schema } from "effect"

import type { Workflow } from "../src/workflow.ts"

const Plan = Schema.toStandardSchemaV1(Schema.Struct({ items: Schema.Array(Schema.String) }))
const Note = Schema.toStandardSchemaV1(Schema.Struct({ item: Schema.String, note: Schema.String }))
const Args = Schema.Struct({ topic: Schema.String })
const decodeArgs = Schema.decodeUnknownSync(Args)

export default async function checkpointResume(wf: Workflow) {
  const { topic } = decodeArgs(wf.args)

  wf.phase("plan")

  const plan = await wf.agent({
    title: "Plan research",
    prompt: `Split research on ${topic} into at most four independent questions. Change no file.`,
    format: "{ items: [question] }",
    schema: Plan,
  })

  wf.phase("research")

  const notes = await wf.parallel(
    plan.items,
    (item) =>
      wf.agent({
        title: `Research ${item}`,
        prompt: `Answer: ${item}. Change no file.`,
        format: "{ item, note }",
        schema: Note,
      }),
    { concurrency: 3 },
  )

  wf.phase("summary")

  const summary = await wf.agent({
    title: "Summarise research",
    prompt: `Summarise these notes on ${topic} in five lines:\n${notes.map((n) => `- ${n.item}: ${n.note}`).join("\n")}`,
  })

  return { topic, notes: notes.map((n) => ({ ...n })), summary }
}
