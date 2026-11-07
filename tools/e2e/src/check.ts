import type { World } from "./world.ts"

export type Tier = "gate" | "slow" | "agent"

export interface Check {
  readonly id: string
  readonly title: string
  readonly tier?: Tier
  readonly run: (w: World, evidence: string) => Promise<void>
}
