import type { World } from "./world.ts"

export interface Check {
  readonly id: string
  readonly title: string
  readonly run: (w: World, evidence: string) => Promise<void>
}
