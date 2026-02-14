import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";

import type { TaskSlice, WorkbenchSlice, WorkspaceSlice } from "./slices";

import { createTaskSlice, createWorkbenchSlice, createWorkspaceSlice } from "./slices";

export type AppStore = WorkspaceSlice & TaskSlice & WorkbenchSlice;

// Vanilla store - can be used outside React
export const appStore = createStore<AppStore>()((...a) => ({
  ...createWorkspaceSlice(...a),
  ...createTaskSlice(...a),
  ...createWorkbenchSlice(...a),
}));

// React hook with selector support
export function useAppStore<T>(selector: (state: AppStore) => T): T {
  return useStore(appStore, selector);
}

// React hook with shallow comparison — use for selectors that return new objects/arrays
export function useAppStoreShallow<T>(selector: (state: AppStore) => T): T {
  return useStore(appStore, useShallow(selector));
}
