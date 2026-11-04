// vibest's guard area (core/guard.ts GuardArea): VIBEST_HOME, its projects directory, and the caller's own project
// folder (VIBEST_PROJECT_DIR) as the one place there it may use.
import type { Layout } from "@vibest/schema/layout"

export const OFF_LIMITS =
  "The projects directory is off limits to sessions, except this project's folder (VIBEST_PROJECT_DIR)."

export const COORDINATOR_EDITS =
  "The coordinator edits files only in the project folder (VIBEST_PROJECT_DIR); hand other changes to a session."

/** The area for a caller whose project folder is `projectDir` (none: nothing under projects is allowed). */
export const guardArea = (layout: Layout["Service"], projectDir: string | undefined) => ({
  home: layout.home,
  protected: layout.projects,
  allowed: projectDir,
  offLimits: OFF_LIMITS,
  entryEdits: COORDINATOR_EDITS,
})
