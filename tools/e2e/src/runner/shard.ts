import { shardWeights } from "./shard-weights.ts"

export type Shard = { readonly index: number; readonly count: number }

export const parseShard = (text: string): Shard | undefined => {
  const match = /^(\d+)\/(\d+)$/.exec(text)
  if (match === null) return undefined
  const [index, count] = [Number(match[1]), Number(match[2])]
  return index >= 1 && index <= count ? { index, count } : undefined
}

const typical = () => {
  const sorted = Object.values(shardWeights).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 1
}

export const shardOf = <T extends { readonly id: string }>(items: ReadonlyArray<T>, shard: Shard): Array<T> => {
  const fallback = typical()
  const weight = (item: T) => shardWeights[item.id] ?? fallback
  const bins = Array.from({ length: shard.count }, () => ({ load: 0, items: [] as Array<T> }))
  for (const item of [...items].sort((a, b) => weight(b) - weight(a) || a.id.localeCompare(b.id))) {
    const lightest = bins.reduce((best, bin) => (bin.load < best.load ? bin : best))
    lightest.items.push(item)
    lightest.load += weight(item)
  }
  return bins[shard.index - 1]!.items
}
