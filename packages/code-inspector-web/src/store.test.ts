import type { Mock } from "vitest";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InspectedTarget, InspectedTargetData, InspectMetadata, InspectState } from "./types";

import { inspectorStore, inspectorStoreSync } from "./store";
import { tryInspectElement } from "./util";

vi.mock("uuid", () => ({
  v7: vi.fn(() => "mock-uuid"),
}));

vi.mock("./util", () => ({
  tryInspectElement: vi.fn(),
}));

const tryInspectElementMock = vi.mocked(tryInspectElement);

type MockedHTMLElement = HTMLElement & {
  contains: Mock<HTMLElement["contains"]>;
  getBoundingClientRect: Mock<() => DOMRect>;
};

const createMockElement = (): MockedHTMLElement => {
  const defaultRect = {
    top: 0,
    left: 0,
    bottom: 10,
    right: 10,
    width: 10,
    height: 10,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;

  const getBoundingClientRect = vi.fn<() => DOMRect>().mockReturnValue(defaultRect);

  return {
    contains: vi.fn<HTMLElement["contains"]>().mockReturnValue(false),
    getBoundingClientRect,
  } as unknown as MockedHTMLElement;
};

const appendTarget = (element: MockedHTMLElement) => {
  const metadata: InspectMetadata = {
    fileName: "src/component.tsx",
    componentName: "Component",
    lineNumber: 10,
    columnNumber: 5,
  };

  tryInspectElementMock.mockReturnValue({
    element,
    metadata,
  });

  inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });

  return { metadata };
};

const syncInspectorContext = (state: InspectState, targets: InspectedTargetData[]) => {
  inspectorStoreSync.trigger.SET_INSPECTED_TARGETS({ targets });
  inspectorStoreSync.trigger.SET_INSPECTED_STATE({ state });
};

describe("inspectorStore", () => {
  beforeEach(() => {
    tryInspectElementMock.mockReset();
    // Reset store to initial state
    inspectorStore.trigger.STOP();
  });

  it("activates on START and returns to idle on STOP", () => {
    expect(inspectorStore.getSnapshot().context.state).toBe("idle");

    inspectorStore.trigger.START();
    expect(inspectorStore.getSnapshot().context.state).toBe("active");

    const element = createMockElement();
    appendTarget(element);

    inspectorStore.trigger.POINTER_DOWN({
      event: {
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as PointerEvent,
    });

    expect(inspectorStore.getSnapshot().context.inspectedTargets).toHaveLength(1);

    inspectorStore.trigger.STOP();

    const snapshot = inspectorStore.getSnapshot().context;
    expect(snapshot.state).toBe("idle");
    expect(snapshot.inspectedTargets).toHaveLength(0);
    expect(snapshot.currentTarget).toBeUndefined();
  });

  it("stores the current hover target on pointer move", () => {
    inspectorStore.trigger.START();

    const element = createMockElement();
    const { metadata } = appendTarget(element);

    const snapshot = inspectorStore.getSnapshot().context;
    expect(snapshot.currentTarget).toEqual({
      element,
      metadata,
    });

    tryInspectElementMock.mockReturnValue(undefined);
    inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });
    expect(inspectorStore.getSnapshot().context.currentTarget).toBeUndefined();
  });

  it("picks the current hover target on pointer down and ignores duplicates", () => {
    inspectorStore.trigger.START();

    const element = createMockElement();
    appendTarget(element);

    const pointerDownEvent = {
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as PointerEvent;

    inspectorStore.trigger.POINTER_DOWN({ event: pointerDownEvent });

    let snapshot = inspectorStore.getSnapshot().context;
    expect(snapshot.inspectedTargets).toHaveLength(1);
    expect(snapshot.currentTarget).toBeUndefined();
    expect(snapshot.inspectedTargets[0].id).toBe("mock-uuid");
    expect(pointerDownEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(pointerDownEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(pointerDownEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1);

    appendTarget(element);
    inspectorStore.trigger.POINTER_DOWN({ event: pointerDownEvent });

    snapshot = inspectorStore.getSnapshot().context;
    expect(snapshot.inspectedTargets).toHaveLength(1);
  });

  it("updates and removes inspected targets", () => {
    inspectorStore.trigger.START();

    const element = createMockElement();
    const metadata = {
      fileName: "src/component.tsx",
      componentName: "Component",
      lineNumber: 1,
      columnNumber: 1,
    };

    tryInspectElementMock.mockReturnValue({ element, metadata });
    inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });
    inspectorStore.trigger.POINTER_DOWN({
      event: {
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as PointerEvent,
    });

    let snapshot = inspectorStore.getSnapshot().context;
    expect(snapshot.inspectedTargets).toHaveLength(1);

    inspectorStore.trigger.REMOVE_INSPECTED_TARGET({
      id: snapshot.inspectedTargets[0].id,
    });

    snapshot = inspectorStore.getSnapshot().context;
    expect(snapshot.inspectedTargets).toHaveLength(0);
  });

  describe("Error handling and edge cases", () => {
    it("should handle tryInspectElement returning undefined", () => {
      inspectorStore.trigger.START();

      // Set up a current target first
      const element = createMockElement();
      appendTarget(element);
      expect(inspectorStore.getSnapshot().context.currentTarget).toBeDefined();

      // Then make tryInspectElement return undefined
      tryInspectElementMock.mockReturnValue(undefined);
      inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.currentTarget).toBeUndefined();
    });

    it("should ignore events when in idle state", () => {
      const element = createMockElement();
      tryInspectElementMock.mockReturnValue({
        element,
        metadata: {
          fileName: "src/component.tsx",
          componentName: "Component",
          lineNumber: 1,
          columnNumber: 1,
        },
      });

      inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });
      inspectorStore.trigger.POINTER_DOWN({ event: {} as PointerEvent });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.state).toBe("idle");
      expect(snapshot.currentTarget).toBeUndefined();
      expect(snapshot.inspectedTargets).toHaveLength(0);
    });

    it("should handle removing non-existent target", () => {
      inspectorStore.trigger.START();

      inspectorStore.trigger.REMOVE_INSPECTED_TARGET({ id: "non-existent-id" });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.inspectedTargets).toHaveLength(0);
    });

    it("should handle element without proper metadata", () => {
      inspectorStore.trigger.START();

      tryInspectElementMock.mockReturnValue(undefined);
      inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.currentTarget).toBeUndefined();
    });

    it("should handle empty inspected targets when updating", () => {
      inspectorStore.trigger.START();

      inspectorStore.trigger.CLEAR_INSPECTED_TARGETS();

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.inspectedTargets).toHaveLength(0);
    });
  });

  describe("Concurrent event handling", () => {
    it("should handle rapid pointer move events", () => {
      inspectorStore.trigger.START();

      const element1 = createMockElement();
      const element2 = createMockElement();

      tryInspectElementMock
        .mockReturnValueOnce({
          element: element1,
          metadata: {
            fileName: "file1.tsx",
            componentName: "Comp1",
            lineNumber: 1,
            columnNumber: 1,
          },
        })
        .mockReturnValueOnce({
          element: element2,
          metadata: {
            fileName: "file2.tsx",
            componentName: "Comp2",
            lineNumber: 2,
            columnNumber: 2,
          },
        })
        .mockReturnValueOnce(undefined);

      inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });
      expect(inspectorStore.getSnapshot().context.currentTarget?.element).toBe(element1);

      inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });
      expect(inspectorStore.getSnapshot().context.currentTarget?.element).toBe(element2);

      inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });
      expect(inspectorStore.getSnapshot().context.currentTarget).toBeUndefined();
    });

    it("should handle pointer down without current target", () => {
      inspectorStore.trigger.START();

      const pointerDownEvent = {
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as PointerEvent;

      inspectorStore.trigger.POINTER_DOWN({ event: pointerDownEvent });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.inspectedTargets).toHaveLength(0);
      expect(pointerDownEvent.preventDefault).toHaveBeenCalled();
    });

    it("should handle pointer leave correctly", () => {
      inspectorStore.trigger.START();

      const element = createMockElement();
      appendTarget(element);

      expect(inspectorStore.getSnapshot().context.currentTarget).toBeDefined();

      inspectorStore.trigger.POINTER_LEAVE();

      expect(inspectorStore.getSnapshot().context.currentTarget).toBeUndefined();
    });
  });

  describe("DOM element changes", () => {
    it("should handle element position changes during inspection", () => {
      inspectorStore.trigger.START();

      const element = createMockElement();

      const metadata = {
        fileName: "src/component.tsx",
        componentName: "Component",
        lineNumber: 10,
        columnNumber: 5,
      };

      tryInspectElementMock.mockReturnValue({ element, metadata });
      inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });

      inspectorStore.trigger.POINTER_DOWN({
        event: {
          preventDefault: vi.fn(),
          stopImmediatePropagation: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as PointerEvent,
      });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.inspectedTargets).toHaveLength(1);
    });

    it("should handle multiple targets with different positions", () => {
      inspectorStore.trigger.START();

      const element1 = createMockElement();
      const element2 = createMockElement();

      tryInspectElementMock
        .mockReturnValueOnce({
          element: element1,
          metadata: {
            fileName: "file1.tsx",
            componentName: "Comp1",
            lineNumber: 1,
            columnNumber: 1,
          },
        })
        .mockReturnValueOnce({
          element: element2,
          metadata: {
            fileName: "file2.tsx",
            componentName: "Comp2",
            lineNumber: 2,
            columnNumber: 2,
          },
        });

      // Add first target
      inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });
      inspectorStore.trigger.POINTER_DOWN({
        event: {
          preventDefault: vi.fn(),
          stopImmediatePropagation: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as PointerEvent,
      });

      // Add second target
      inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });
      inspectorStore.trigger.POINTER_DOWN({
        event: {
          preventDefault: vi.fn(),
          stopImmediatePropagation: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as PointerEvent,
      });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.inspectedTargets).toHaveLength(2);
    });
  });

  describe("SET_INSPECTED_TARGETS event", () => {
    it("should set inspected targets from external source", () => {
      inspectorStore.trigger.START();

      const element1 = createMockElement();
      const element2 = createMockElement();

      const targets: InspectedTarget[] = [
        {
          id: "target-1",
          element: element1,
          metadata: {
            fileName: "file1.tsx",
            componentName: "Comp1",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
        {
          id: "target-2",
          element: element2,
          metadata: {
            fileName: "file2.tsx",
            componentName: "Comp2",
            lineNumber: 20,
            columnNumber: 10,
          },
        },
      ];

      inspectorStore.trigger.SET_INSPECTED_TARGETS({ targets });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.inspectedTargets).toEqual(targets);
      expect(snapshot.inspectedTargets).toHaveLength(2);
    });

    it("should replace existing inspected targets", () => {
      inspectorStore.trigger.START();

      // Add a target through normal inspection
      const element1 = createMockElement();
      appendTarget(element1);
      inspectorStore.trigger.POINTER_DOWN({
        event: {
          preventDefault: vi.fn(),
          stopImmediatePropagation: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as PointerEvent,
      });

      expect(inspectorStore.getSnapshot().context.inspectedTargets).toHaveLength(1);

      // Replace with new targets
      const element2 = createMockElement();
      const newTargets: InspectedTarget[] = [
        {
          id: "new-target",
          element: element2,
          metadata: {
            fileName: "new-file.tsx",
            componentName: "NewComp",
            lineNumber: 15,
            columnNumber: 8,
          },
        },
      ];

      inspectorStore.trigger.SET_INSPECTED_TARGETS({ targets: newTargets });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.inspectedTargets).toEqual(newTargets);
      expect(snapshot.inspectedTargets).toHaveLength(1);
    });

    it("should handle empty targets array", () => {
      inspectorStore.trigger.START();

      // Add some targets first
      const element = createMockElement();
      appendTarget(element);
      inspectorStore.trigger.POINTER_DOWN({
        event: {
          preventDefault: vi.fn(),
          stopImmediatePropagation: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as PointerEvent,
      });

      expect(inspectorStore.getSnapshot().context.inspectedTargets).toHaveLength(1);

      // Set to empty array
      inspectorStore.trigger.SET_INSPECTED_TARGETS({ targets: [] });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.inspectedTargets).toEqual([]);
      expect(snapshot.inspectedTargets).toHaveLength(0);
    });

    it("should preserve targets with partial metadata", () => {
      inspectorStore.trigger.START();

      const element = createMockElement();
      const targets: InspectedTarget[] = [
        {
          id: "partial-target",
          element,
          metadata: {
            componentName: "PartialComp",
            // fileName, lineNumber, columnNumber are optional
          },
        },
      ];

      inspectorStore.trigger.SET_INSPECTED_TARGETS({ targets });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.inspectedTargets).toEqual(targets);
      expect(snapshot.inspectedTargets[0].metadata.fileName).toBeUndefined();
      expect(snapshot.inspectedTargets[0].metadata.lineNumber).toBeUndefined();
      expect(snapshot.inspectedTargets[0].metadata.columnNumber).toBeUndefined();
    });

    it("should not affect current target when setting inspected targets", () => {
      inspectorStore.trigger.START();

      // Set a current target through hover
      const currentElement = createMockElement();
      const currentMetadata = {
        fileName: "current.tsx",
        componentName: "CurrentComp",
        lineNumber: 5,
        columnNumber: 3,
      };

      tryInspectElementMock.mockReturnValue({
        element: currentElement,
        metadata: currentMetadata,
      });

      inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });
      expect(inspectorStore.getSnapshot().context.currentTarget).toBeDefined();

      // Set inspected targets
      const element = createMockElement();
      const targets: InspectedTarget[] = [
        {
          id: "new-target",
          element,
          metadata: {
            fileName: "new.tsx",
            componentName: "NewComp",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
      ];

      inspectorStore.trigger.SET_INSPECTED_TARGETS({ targets });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.currentTarget).toBeDefined();
      expect(snapshot.currentTarget?.element).toBe(currentElement);
      expect(snapshot.inspectedTargets).toEqual(targets);
    });

    it("should work in any state (for RPC sync)", () => {
      const element = createMockElement();
      const targets: InspectedTarget[] = [
        {
          id: "idle-target",
          element,
          metadata: {
            fileName: "file.tsx",
            componentName: "Comp",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
      ];

      // Can set targets even in idle state (for RPC sync)
      inspectorStore.trigger.SET_INSPECTED_TARGETS({ targets });

      expect(inspectorStore.getSnapshot().context.state).toBe("idle");
      expect(inspectorStore.getSnapshot().context.inspectedTargets).toEqual(targets);

      // Also works in active state
      inspectorStore.trigger.START();
      inspectorStore.trigger.SET_INSPECTED_TARGETS({ targets });

      expect(inspectorStore.getSnapshot().context.inspectedTargets).toEqual(targets);
    });
  });

  describe("Complex user interactions", () => {
    it("should handle hover then click sequence", () => {
      inspectorStore.trigger.START();

      const element = createMockElement();
      const { metadata } = appendTarget(element);

      expect(inspectorStore.getSnapshot().context.currentTarget?.metadata).toEqual(metadata);

      inspectorStore.trigger.POINTER_DOWN({
        event: {
          preventDefault: vi.fn(),
          stopImmediatePropagation: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as PointerEvent,
      });

      const snapshot = inspectorStore.getSnapshot().context;
      expect(snapshot.inspectedTargets).toHaveLength(1);
      expect(snapshot.currentTarget).toBeUndefined();
    });

    it("should handle multiple hovers without clicks", () => {
      inspectorStore.trigger.START();

      const elements = [createMockElement(), createMockElement(), createMockElement()];

      elements.forEach((element, index) => {
        tryInspectElementMock.mockReturnValueOnce({
          element,
          metadata: {
            fileName: `file${index}.tsx`,
            componentName: `Comp${index}`,
            lineNumber: index + 1,
            columnNumber: index + 1,
          },
        });

        inspectorStore.trigger.POINTER_MOVE({ event: {} as PointerEvent });
        expect(inspectorStore.getSnapshot().context.currentTarget?.element).toBe(element);
      });

      expect(inspectorStore.getSnapshot().context.inspectedTargets).toHaveLength(0);
    });

    it("should handle restart after stop", () => {
      inspectorStore.trigger.START();

      const element = createMockElement();
      appendTarget(element);

      inspectorStore.trigger.POINTER_DOWN({
        event: {
          preventDefault: vi.fn(),
          stopImmediatePropagation: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as PointerEvent,
      });

      expect(inspectorStore.getSnapshot().context.inspectedTargets).toHaveLength(1);

      inspectorStore.trigger.STOP();
      expect(inspectorStore.getSnapshot().context.state).toBe("idle");
      expect(inspectorStore.getSnapshot().context.inspectedTargets).toHaveLength(0);

      inspectorStore.trigger.START();
      expect(inspectorStore.getSnapshot().context.state).toBe("active");

      appendTarget(element);
      expect(inspectorStore.getSnapshot().context.currentTarget).toBeDefined();
    });
  });
});

describe("inspectorStoreSync", () => {
  beforeEach(() => {
    // Reset store to initial state
    inspectorStoreSync.trigger.STOP();
  });

  describe("Basic state management", () => {
    it("should start in idle state", () => {
      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.state).toBe("idle");
      expect(snapshot.inspectedTargets).toEqual([]);
    });

    it("should transition to active on START", () => {
      inspectorStoreSync.trigger.START();
      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.state).toBe("active");
    });

    it("should return to idle and clear targets on STOP", () => {
      // Set up some targets
      const targets: InspectedTargetData[] = [
        {
          id: "target-1",

          metadata: {
            fileName: "file.tsx",
            componentName: "Comp",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
      ];

      inspectorStoreSync.trigger.START();
      syncInspectorContext("active", targets);

      expect(inspectorStoreSync.getSnapshot().context.inspectedTargets).toHaveLength(1);

      inspectorStoreSync.trigger.STOP();

      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.state).toBe("idle");
      expect(snapshot.inspectedTargets).toEqual([]);
    });
  });

  describe("Target management", () => {
    it("should remove a specific target", () => {
      const targets: InspectedTargetData[] = [
        {
          id: "target-1",

          metadata: {
            fileName: "file1.tsx",
            componentName: "Comp1",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
        {
          id: "target-2",

          metadata: {
            fileName: "file2.tsx",
            componentName: "Comp2",
            lineNumber: 20,
            columnNumber: 10,
          },
        },
      ];

      syncInspectorContext("active", targets);

      expect(inspectorStoreSync.getSnapshot().context.inspectedTargets).toHaveLength(2);

      inspectorStoreSync.trigger.REMOVE_INSPECTED_TARGET({ id: "target-1" });

      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.inspectedTargets).toHaveLength(1);
      expect(snapshot.inspectedTargets[0].id).toBe("target-2");
    });

    it("should clear all targets", () => {
      const targets: InspectedTargetData[] = [
        {
          id: "target-1",

          metadata: {
            fileName: "file.tsx",
            componentName: "Comp",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
      ];

      syncInspectorContext("active", targets);

      expect(inspectorStoreSync.getSnapshot().context.inspectedTargets).toHaveLength(1);

      inspectorStoreSync.trigger.CLEAR_INSPECTED_TARGETS();

      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.inspectedTargets).toEqual([]);
    });

    it("should handle removing non-existent target", () => {
      const targets: InspectedTargetData[] = [
        {
          id: "target-1",

          metadata: {
            fileName: "file.tsx",
            componentName: "Comp",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
      ];

      syncInspectorContext("active", targets);

      inspectorStoreSync.trigger.REMOVE_INSPECTED_TARGET({
        id: "non-existent",
      });

      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.inspectedTargets).toHaveLength(1);
      expect(snapshot.inspectedTargets[0].id).toBe("target-1");
    });
  });

  describe("RPC sync via separate SET events", () => {
    it("should sync targets and state from iframe", () => {
      const targets: InspectedTargetData[] = [
        {
          id: "synced-target",

          metadata: {
            fileName: "synced.tsx",
            componentName: "SyncedComp",
            lineNumber: 15,
            columnNumber: 8,
          },
        },
      ];

      syncInspectorContext("active", targets);

      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.state).toBe("active");
      expect(snapshot.inspectedTargets).toEqual(targets);
    });

    it("should replace existing targets with synced data", () => {
      // Set initial targets
      const initialTargets: InspectedTargetData[] = [
        {
          id: "initial",

          metadata: {
            fileName: "initial.tsx",
            componentName: "Initial",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
      ];

      syncInspectorContext("active", initialTargets);

      // Sync with new targets
      const syncedTargets: InspectedTargetData[] = [
        {
          id: "synced",

          metadata: {
            fileName: "synced.tsx",
            componentName: "Synced",
            lineNumber: 20,
            columnNumber: 10,
          },
        },
      ];

      syncInspectorContext("active", syncedTargets);

      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.inspectedTargets).toEqual(syncedTargets);
      expect(snapshot.inspectedTargets).toHaveLength(1);
      expect(snapshot.inspectedTargets[0].id).toBe("synced");
    });

    it("should sync empty targets", () => {
      // Set some targets first
      const targets: InspectedTargetData[] = [
        {
          id: "target",

          metadata: {
            fileName: "file.tsx",
            componentName: "Comp",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
      ];

      syncInspectorContext("active", targets);

      // Sync with empty targets
      syncInspectorContext("idle", []);

      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.state).toBe("idle");
      expect(snapshot.inspectedTargets).toEqual([]);
    });

    it("should work in any state (for RPC sync)", () => {
      const targets: InspectedTargetData[] = [
        {
          id: "target",

          metadata: {
            fileName: "file.tsx",
            componentName: "Comp",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
      ];

      // Can sync even in idle state
      expect(inspectorStoreSync.getSnapshot().context.state).toBe("idle");

      syncInspectorContext("active", targets);

      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.state).toBe("active");
      expect(snapshot.inspectedTargets).toEqual(targets);
    });
  });

  describe("Optimistic updates", () => {
    it("should handle START → STOP sequence", () => {
      expect(inspectorStoreSync.getSnapshot().context.state).toBe("idle");

      inspectorStoreSync.trigger.START();
      expect(inspectorStoreSync.getSnapshot().context.state).toBe("active");

      inspectorStoreSync.trigger.STOP();
      expect(inspectorStoreSync.getSnapshot().context.state).toBe("idle");
    });

    it("should preserve state during target operations", () => {
      const targets: InspectedTargetData[] = [
        {
          id: "target-1",

          metadata: {
            fileName: "file1.tsx",
            componentName: "Comp1",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
        {
          id: "target-2",

          metadata: {
            fileName: "file2.tsx",
            componentName: "Comp2",
            lineNumber: 20,
            columnNumber: 10,
          },
        },
      ];

      inspectorStoreSync.trigger.START();
      syncInspectorContext("active", targets);

      expect(inspectorStoreSync.getSnapshot().context.state).toBe("active");

      inspectorStoreSync.trigger.REMOVE_INSPECTED_TARGET({ id: "target-1" });

      const snapshot = inspectorStoreSync.getSnapshot().context;
      expect(snapshot.state).toBe("active");
      expect(snapshot.inspectedTargets).toHaveLength(1);
    });

    it("should handle multiple target operations", () => {
      // Initial sync
      syncInspectorContext("active", [
        {
          id: "target-1",

          metadata: {
            fileName: "file1.tsx",
            componentName: "Comp1",
            lineNumber: 10,
            columnNumber: 5,
          },
        },
        {
          id: "target-2",

          metadata: {
            fileName: "file2.tsx",
            componentName: "Comp2",
            lineNumber: 20,
            columnNumber: 10,
          },
        },
        {
          id: "target-3",

          metadata: {
            fileName: "file3.tsx",
            componentName: "Comp3",
            lineNumber: 30,
            columnNumber: 15,
          },
        },
      ]);

      expect(inspectorStoreSync.getSnapshot().context.inspectedTargets).toHaveLength(3);

      // Remove one
      inspectorStoreSync.trigger.REMOVE_INSPECTED_TARGET({ id: "target-2" });
      expect(inspectorStoreSync.getSnapshot().context.inspectedTargets).toHaveLength(2);

      // Clear all
      inspectorStoreSync.trigger.CLEAR_INSPECTED_TARGETS();
      expect(inspectorStoreSync.getSnapshot().context.inspectedTargets).toHaveLength(0);
    });
  });
});
