export type SplitTarget = "active" | "primary" | { splitId: string };

export interface PaneLeaf {
  id: string;
  kind: string;
  title: string;
  state?: unknown;
}

export interface SplitState {
  splitOrder: string[];
  primarySplitId: string;
  activeSplitId: string;
  tabsBySplitId: Record<string, PaneLeaf[]>;
  activeTabBySplitId: Record<string, string | null>;
}

export function createSplitState(primarySplitId = "split-primary"): SplitState {
  return {
    splitOrder: [primarySplitId],
    primarySplitId,
    activeSplitId: primarySplitId,
    tabsBySplitId: {
      [primarySplitId]: [],
    },
    activeTabBySplitId: {
      [primarySplitId]: null,
    },
  };
}

export function resolveTargetSplitId(state: SplitState, target: SplitTarget): string {
  if (target === "active") {
    return state.splitOrder.includes(state.activeSplitId)
      ? state.activeSplitId
      : state.primarySplitId;
  }

  if (target === "primary") {
    return state.primarySplitId;
  }

  return state.splitOrder.includes(target.splitId) ? target.splitId : state.primarySplitId;
}

export function toggleSecondarySplit(state: SplitState, createSplitId: () => string): SplitState {
  if (state.splitOrder.length > 1) {
    const primaryTabs = state.tabsBySplitId[state.primarySplitId] ?? [];
    const primaryActiveTab = state.activeTabBySplitId[state.primarySplitId] ?? null;

    return {
      ...state,
      splitOrder: [state.primarySplitId],
      activeSplitId: state.primarySplitId,
      tabsBySplitId: {
        [state.primarySplitId]: primaryTabs,
      },
      activeTabBySplitId: {
        [state.primarySplitId]: primaryActiveTab,
      },
    };
  }

  const secondarySplitId = createSplitId();
  return {
    ...state,
    splitOrder: [state.primarySplitId, secondarySplitId],
    activeSplitId: secondarySplitId,
    tabsBySplitId: {
      ...state.tabsBySplitId,
      [secondarySplitId]: [],
    },
    activeTabBySplitId: {
      ...state.activeTabBySplitId,
      [secondarySplitId]: null,
    },
  };
}

export function upsertLeafTab(state: SplitState, target: SplitTarget, leaf: PaneLeaf): SplitState {
  const splitId = resolveTargetSplitId(state, target);
  const tabs = state.tabsBySplitId[splitId] ?? [];
  const existingIndex = tabs.findIndex((tab) => tab.id === leaf.id);

  const nextTabs =
    existingIndex === -1
      ? [...tabs, leaf]
      : tabs.map((tab, index) => (index === existingIndex ? leaf : tab));

  return {
    ...state,
    tabsBySplitId: {
      ...state.tabsBySplitId,
      [splitId]: nextTabs,
    },
    activeTabBySplitId: {
      ...state.activeTabBySplitId,
      [splitId]: leaf.id,
    },
    activeSplitId: splitId,
  };
}

export function setActiveSplit(state: SplitState, splitId: string): SplitState {
  if (!state.splitOrder.includes(splitId)) {
    return state;
  }

  return {
    ...state,
    activeSplitId: splitId,
  };
}

export function setActiveTab(state: SplitState, splitId: string, tabId: string | null): SplitState {
  if (!state.splitOrder.includes(splitId)) {
    return state;
  }

  if (tabId !== null) {
    const hasTab = (state.tabsBySplitId[splitId] ?? []).some((tab) => tab.id === tabId);
    if (!hasTab) {
      return state;
    }
  }

  return {
    ...state,
    activeTabBySplitId: {
      ...state.activeTabBySplitId,
      [splitId]: tabId,
    },
  };
}

export function closeLeafTab(state: SplitState, splitId: string, tabId: string): SplitState {
  if (!state.splitOrder.includes(splitId)) {
    return state;
  }

  const tabs = state.tabsBySplitId[splitId] ?? [];
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) {
    return state;
  }

  const nextTabs = tabs.filter((tab) => tab.id !== tabId);
  const currentActiveTabId = state.activeTabBySplitId[splitId] ?? null;

  let nextActiveTabId = currentActiveTabId;
  if (currentActiveTabId === tabId) {
    const fallbackIndex = Math.max(0, index - 1);
    nextActiveTabId = nextTabs[fallbackIndex]?.id ?? null;
  }

  return {
    ...state,
    tabsBySplitId: {
      ...state.tabsBySplitId,
      [splitId]: nextTabs,
    },
    activeTabBySplitId: {
      ...state.activeTabBySplitId,
      [splitId]: nextActiveTabId,
    },
  };
}
