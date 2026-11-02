import type { World } from "./world.ts"

/** One feature-map ID (docs/testing/feature-map.md). `run` throws to fail, throws `Skip` to skip. */
export interface Check {
  readonly id: string
  readonly title: string
  readonly run: (w: World) => Promise<void>
}
