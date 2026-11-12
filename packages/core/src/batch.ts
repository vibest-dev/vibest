import type { InboxRow } from "@vibest/schema/session"

export const senderKey = (row: InboxRow) => (row.kind === "notice" ? "vibestd" : (row.sender ?? ""))

export const nextBatch = (pending: ReadonlyArray<InboxRow>) => {
  const first = pending[0] ? senderKey(pending[0]) : undefined
  const other = pending.findIndex((r) => senderKey(r) !== first)
  return other === -1 ? pending : pending.slice(0, other)
}
