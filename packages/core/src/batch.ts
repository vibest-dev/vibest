import type { InboxRow } from "@vibest/schema/session"

import { senderKey } from "./database/db-rows.ts"

export const nextBatch = (pending: ReadonlyArray<InboxRow>) => {
  const first = pending[0] ? senderKey(pending[0].sender) : undefined
  const other = pending.findIndex((r) => senderKey(r.sender) !== first)

  return other === -1 ? pending : pending.slice(0, other)
}
