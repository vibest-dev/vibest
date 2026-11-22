import { ACCESS } from "@vibest/protocol/access"
import { VibestRpcs } from "@vibest/protocol/rpc"

type Tag = keyof typeof ACCESS

const isTag = (key: string): key is Tag => Object.hasOwn(ACCESS, key)

const everyTag = Object.keys(ACCESS).filter(isTag)

export const group = <const Own extends ReadonlyArray<Tag>>(own: Own) => {
  const isOther = (tag: Tag): tag is Exclude<Tag, Own[number]> => !own.includes(tag)

  return VibestRpcs.omit(...everyTag.filter(isOther))
}
