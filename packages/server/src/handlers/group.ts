import { ACCESS, VibestRpcs } from "@vibest/protocol/rpc"

type Tag = keyof typeof ACCESS

const everyTag = Object.keys(ACCESS) as ReadonlyArray<Tag>

export const group = <const Own extends ReadonlyArray<Tag>>(own: Own) =>
  VibestRpcs.omit(...(everyTag.filter((tag) => !own.includes(tag)) as Array<Exclude<Tag, Own[number]>>))
