import { Context, Effect, Layer, Option, Predicate, type Schema, Stream, SubscriptionRef } from "effect"

import { LayerNode } from "./effect/layer-node.ts"

export * as Concurrency from "./concurrency.ts"

export interface Rules {
  readonly max: number | undefined
  readonly problems: ReadonlyArray<string>
  readonly unsupported: ReadonlyArray<string>
}

const FILTERS = ["harness", "agent"] as const

const FIELDS = new Set<string>(["max", ...FILTERS])

const NO_RULES: Rules = { max: undefined, problems: [], unsupported: [] }

const isRule = (rule: Schema.Json): rule is Schema.JsonObject => Predicate.isObject(rule) && !Array.isArray(rule)

const ruleProblem = (rule: Schema.Json) => {
  if (!isRule(rule)) return 'is not an object such as { "max": 4 }'
  const unknown = Object.keys(rule).filter((field) => !FIELDS.has(field))

  if (unknown.length > 0) return `has unknown fields: ${unknown.join(", ")}`
  const max = rule.max

  if (!Predicate.isNumber(max) || !Number.isInteger(max) || max < 1) return "needs max as a positive integer"
  const notText = FILTERS.filter((filter) => rule[filter] !== undefined && !Predicate.isString(rule[filter]))

  return notText.length > 0 ? `has ${notText.join(" and ")} that is not text` : undefined
}

export const rulesOf = (raw: Schema.Json | undefined): Rules => {
  if (raw === undefined) return NO_RULES

  if (!Array.isArray(raw))
    return {
      ...NO_RULES,
      problems: ['"concurrency" is not a list of rules such as [{ "max": 4 }]; no rule is applied'],
    }
  const problems: Array<string> = []
  const unsupported: Array<string> = []
  const maxima: Array<number> = []

  raw.forEach((rule: Schema.Json, i: number) => {
    const label = `concurrency rule ${i + 1} ${JSON.stringify(rule)}`
    const problem = ruleProblem(rule)

    if (problem !== undefined) problems.push(`${label} ${problem}; it is not applied`)
    else if (isRule(rule) && FILTERS.some((filter) => rule[filter] !== undefined))
      unsupported.push(`${label}: rules with harness or agent are not supported yet; it is not applied`)
    else if (isRule(rule) && Predicate.isNumber(rule.max)) maxima.push(rule.max)
  })

  return { max: maxima.length === 0 ? undefined : Math.min(...maxima), problems, unsupported }
}

export interface Admission {
  readonly limit: number
  readonly passed: ReadonlyArray<string>
}

export const atLimit = (limit: number | undefined, working: number) => limit !== undefined && working >= limit

export const make = Effect.gen(function* () {
  const current = yield* SubscriptionRef.make(NO_RULES)
  const limit = Effect.map(SubscriptionRef.get(current), (rules) => rules.max)
  const passed = new Set<string>()

  return {
    rules: SubscriptionRef.get(current),
    limit,
    admission: Effect.map(limit, (max): Admission | undefined =>
      max === undefined ? undefined : { limit: max, passed: [...passed] },
    ),
    pass: (sessionId: string, cannotTake: boolean) =>
      Effect.sync(() => void (cannotTake ? passed.add(sessionId) : passed.delete(sessionId))),
    limits: SubscriptionRef.changes(current).pipe(
      Stream.map((rules) => rules.max),
      Stream.changes,
    ),
    configure: Effect.fn("Concurrency.configure")((raw: Schema.Json | undefined) =>
      SubscriptionRef.updateSome(current, (rules) => {
        const next = rulesOf(raw)

        return JSON.stringify(next) === JSON.stringify(rules) ? Option.none() : Option.some(next)
      }),
    ),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Concurrency") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [] })
