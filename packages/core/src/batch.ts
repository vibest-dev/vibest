import type { InboxRow } from "@vibest/schema/session"
import { Predicate } from "effect"

const senderKey = ({ sender }: InboxRow) => {
  if (Predicate.isString(sender)) return sender

  return "plugin" in sender ? `plugin:${sender.plugin}` : `${sender.machine ?? ""}/${sender.session}`
}

export const nextBatch = (pending: ReadonlyArray<InboxRow>) => {
  const first = pending[0] ? senderKey(pending[0]) : undefined
  const other = pending.findIndex((r) => senderKey(r) !== first)

  return other === -1 ? pending : pending.slice(0, other)
}
