import { Schema } from "effect"

export const MessageStatus = Schema.Literals(["working", "completed", "failed", "interrupted", "lost", "not_started"])
export type MessageStatus = typeof MessageStatus.Type
