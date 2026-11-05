import type { World } from "./world.ts"

/** One feature-map ID (docs/testing/feature-map.md). `run` throws to fail, throws `Skip` to skip. */
export interface Check {
  readonly id: string
  readonly title: string
  /** `evidence` is this run's directory, `tools/e2e/evidence/<run>/`. */
  readonly run: (w: World, evidence: string) => Promise<void>
}
