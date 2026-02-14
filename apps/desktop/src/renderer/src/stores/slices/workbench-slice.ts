import type { StateCreator } from "zustand/vanilla";

import type { WorkbenchState } from "../../workbench/types";
import { createWorkbenchState } from "../../workbench/types";

export interface WorkbenchSlice {
  workbench: WorkbenchState;
}

export const createWorkbenchSlice: StateCreator<WorkbenchSlice, [], [], WorkbenchSlice> = () => ({
  workbench: createWorkbenchState(),
});
