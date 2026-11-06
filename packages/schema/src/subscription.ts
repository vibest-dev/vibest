import { Schema } from "effect"

import { HARNESS_IDS } from "./session.ts"

export const SubscriptionAccount = Schema.Struct({
  kind: Schema.Literals(["subscription", "api-key", "none"]),
  plan: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
})
export type SubscriptionAccount = typeof SubscriptionAccount.Type

export const SubscriptionLimit = Schema.Struct({
  window: Schema.String,
  percent: Schema.Number,
  status: Schema.Literals(["available", "limited"]),
  resetTime: Schema.NullOr(Schema.Number),
})
export type SubscriptionLimit = typeof SubscriptionLimit.Type

export const Subscription = Schema.Struct({
  harness: Schema.Literals(HARNESS_IDS),
  provider: Schema.String,
  machine: Schema.Literal("local"),
  account: SubscriptionAccount,
  limits: Schema.Array(SubscriptionLimit),
  updatedAt: Schema.Number,
  error: Schema.optional(Schema.String),
})
export type Subscription = typeof Subscription.Type
