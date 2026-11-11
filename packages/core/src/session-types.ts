import type { Crypto, FileSystem, Path, Ref } from "effect"
import type { ChildProcessSpawner } from "effect/process"

import type { Git } from "./worktree.ts"

export type Platform = FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner | Git

export interface Tracked {
  readonly endedAt: Ref.Ref<number | undefined>
  readonly blockedNotified: Ref.Ref<boolean>
  readonly prompting: Ref.Ref<boolean>
  readonly stopping: Ref.Ref<boolean>
  readonly archiveTold: Ref.Ref<boolean>
  readonly launchRechecked: Ref.Ref<boolean>
}
