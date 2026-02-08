import { describe, expect, it } from "vitest";

import {
  closeLeafTab,
  createSplitState,
  resolveTargetSplitId,
  setActiveSplit,
  setActiveTab,
  toggleSecondarySplit,
  upsertLeafTab,
  type PaneLeaf,
  type SplitState,
  type SplitTarget,
} from "./split-state";

function leaf(kind: string, id: string, title: string): PaneLeaf {
  return { id, kind, title };
}

describe("split-state", () => {
  it("creates minimal default state", () => {
    const state = createSplitState();

    expect(state.splitOrder).toEqual([state.primarySplitId]);
    expect(state.activeSplitId).toBe(state.primarySplitId);
    expect(state.tabsBySplitId[state.primarySplitId]).toEqual([]);
    expect(state.activeTabBySplitId[state.primarySplitId]).toBeNull();
  });

  it("resolves target split id with fallback", () => {
    const base = createSplitState();
    const secondaryId = "split-secondary";
    const state: SplitState = {
      ...base,
      splitOrder: [base.primarySplitId, secondaryId],
      tabsBySplitId: {
        ...base.tabsBySplitId,
        [secondaryId]: [],
      },
      activeTabBySplitId: {
        ...base.activeTabBySplitId,
        [secondaryId]: null,
      },
      activeSplitId: secondaryId,
    };

    expect(resolveTargetSplitId(state, "active")).toBe(secondaryId);
    expect(resolveTargetSplitId(state, "primary")).toBe(base.primarySplitId);
    expect(resolveTargetSplitId(state, { splitId: secondaryId })).toBe(secondaryId);
    expect(resolveTargetSplitId(state, { splitId: "missing" })).toBe(base.primarySplitId);
  });

  it("toggles secondary split on/off", () => {
    const idFactory = (() => {
      let i = 0;
      return () => `split-${++i}`;
    })();

    const base = createSplitState();
    const withSecondary = toggleSecondarySplit(base, idFactory);

    expect(withSecondary.splitOrder).toHaveLength(2);
    expect(withSecondary.splitOrder[0]).toBe(base.primarySplitId);

    const restored = toggleSecondarySplit(withSecondary, idFactory);
    expect(restored.splitOrder).toEqual([base.primarySplitId]);
    expect(restored.activeSplitId).toBe(base.primarySplitId);
  });

  it("keeps tabs isolated per split and activates opened tab in target split", () => {
    const idFactory = (() => {
      let i = 0;
      return () => `split-${++i}`;
    })();

    const base = createSplitState();
    const withSecondary = toggleSecondarySplit(base, idFactory);
    const secondary = withSecondary.splitOrder[1]!;

    const terminalLeaf = leaf("terminal", "leaf-t", "Terminal");
    const diffLeaf = leaf("diff", "leaf-d", "Diff");

    const withTerminal = upsertLeafTab(withSecondary, "primary", terminalLeaf);
    const withDiffOnSecondary = upsertLeafTab(withTerminal, { splitId: secondary }, diffLeaf);

    expect(withDiffOnSecondary.tabsBySplitId[withSecondary.primarySplitId]).toHaveLength(1);
    expect(withDiffOnSecondary.tabsBySplitId[secondary]).toHaveLength(1);
    expect(withDiffOnSecondary.activeTabBySplitId[withSecondary.primarySplitId]).toBe("leaf-t");
    expect(withDiffOnSecondary.activeTabBySplitId[secondary]).toBe("leaf-d");
  });

  it("does not duplicate same leaf id in a split", () => {
    const base = createSplitState();
    const first = upsertLeafTab(base, "primary", leaf("terminal", "leaf-t", "Terminal"));
    const second = upsertLeafTab(first, "primary", leaf("terminal", "leaf-t", "Terminal"));

    expect(second.tabsBySplitId[base.primarySplitId]).toHaveLength(1);
    expect(second.activeTabBySplitId[base.primarySplitId]).toBe("leaf-t");
  });

  it("supports generic target type", () => {
    const base = createSplitState();
    const target: SplitTarget = "primary";
    const state = upsertLeafTab(base, target, leaf("browser", "leaf-b", "Browser"));

    expect(state.tabsBySplitId[base.primarySplitId]).toHaveLength(1);
  });

  it("sets active split/tab safely", () => {
    const base = createSplitState();
    const withLeaf = upsertLeafTab(base, "primary", leaf("terminal", "leaf-t", "Terminal"));
    const splitId = withLeaf.primarySplitId;

    const withActiveSplit = setActiveSplit(withLeaf, splitId);
    expect(withActiveSplit.activeSplitId).toBe(splitId);

    const withActiveTab = setActiveTab(withActiveSplit, splitId, "leaf-t");
    expect(withActiveTab.activeTabBySplitId[splitId]).toBe("leaf-t");
  });

  it("closes tab and reselects adjacent tab", () => {
    const base = createSplitState();
    const splitId = base.primarySplitId;
    const withT = upsertLeafTab(base, "primary", leaf("terminal", "leaf-t", "Terminal"));
    const withD = upsertLeafTab(withT, "primary", leaf("diff", "leaf-d", "Diff"));

    const closed = closeLeafTab(withD, splitId, "leaf-d");
    expect(closed.tabsBySplitId[splitId].map((t) => t.id)).toEqual(["leaf-t"]);
    expect(closed.activeTabBySplitId[splitId]).toBe("leaf-t");
  });
});
