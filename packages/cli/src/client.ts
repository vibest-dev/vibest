import { makeClient } from "@vibest/client/client"

import { VERSION } from "./version.ts"

export const clients = makeClient({ version: VERSION })
export const { withVibest } = clients
