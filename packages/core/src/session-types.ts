import type { Crypto, FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"

import type { Git } from "./worktree.ts"

export type Platform = FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner | Git
