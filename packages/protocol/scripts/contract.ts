import fs from "node:fs"
import path from "node:path"

import { Schema } from "effect"
import { RpcSchema } from "effect/rpc"

import { ACCESS, CAPABILITIES, PROTOCOL, VibestRpcs } from "../src/rpc.ts"

const CONTRACT_DIR = path.join(import.meta.dirname, "..", "contract")
const RPC_JSON = path.join(CONTRACT_DIR, "rpc.json")

const document = (schema: Schema.Top) => {
  const { schema: root, definitions } = Schema.toJsonSchemaDocument(schema)
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...root,
    ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
  }
}

const contract = () => {
  const methods: Record<string, unknown> = {}
  for (const [tag, rpc] of [...VibestRpcs.requests].sort(([a], [b]) => a.localeCompare(b))) {
    const stream = RpcSchema.isStreamSchema(rpc.successSchema)
    const success = stream ? rpc.successSchema.success : rpc.successSchema
    const errors = [
      ...(stream ? [rpc.successSchema.error] : []),
      rpc.errorSchema,
      ...[...rpc.middlewares].map((middleware) => middleware.error),
    ]
    methods[tag] = {
      access: ACCESS[tag as keyof typeof ACCESS],
      stream,
      payload: document(rpc.payloadSchema),
      success: document(success),
      error: document(Schema.Union(errors)),
    }
  }
  return { protocol: PROTOCOL, capabilities: CAPABILITIES, methods }
}

const render = () => `${JSON.stringify(contract(), null, 2)}\n`

if (import.meta.main) {
  fs.mkdirSync(CONTRACT_DIR, { recursive: true })
  fs.writeFileSync(RPC_JSON, render())
}
