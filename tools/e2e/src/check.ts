import type { World } from "./world.ts"

export type Tier = "gate" | "slow" | "agent"

export interface Check {
  readonly id: string
  readonly title: string
  readonly tier?: Tier
  readonly covers?: ReadonlyArray<string>
  readonly entry?: true
  readonly run: (w: World, evidence: string) => Promise<void>
}
