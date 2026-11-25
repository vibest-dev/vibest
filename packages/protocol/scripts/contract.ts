import fs from "node:fs"
import path from "node:path"

import { PROTOCOL } from "@vibest/schema/version"
import { OpenApi } from "effect/http-api"

import { ACCESS } from "../src/access.ts"
import { VibestApi } from "../src/api.ts"
import { CAPABILITIES } from "../src/protocol.ts"

const CONTRACT_DIR = path.join(import.meta.dirname, "..", "contract")
export const OPENAPI_JSON = path.join(CONTRACT_DIR, "openapi.json")

const contract = () => ({
  protocol: PROTOCOL,
  capabilities: CAPABILITIES,
  access: ACCESS,
  openapi: OpenApi.fromApi(VibestApi),
})

export const render = () => `${JSON.stringify(contract(), null, 2)}\n`

if (import.meta.main) {
  fs.mkdirSync(CONTRACT_DIR, { recursive: true })
  fs.writeFileSync(OPENAPI_JSON, render())
}
