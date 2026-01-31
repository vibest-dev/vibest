import { createStore } from "@xstate/store";
import { v7 as uuid } from "uuid";

import type { InspectedTarget, InspectedTargetData, InspectState } from "./types";

import { tryInspectElement } from "./util";

/**
 * Inspector Store - For iframe/client side (with emit events)
 *
 * Full-featured store with pointer event handling and emit events.
 * Used in iframe where actual DOM inspection happens.
 */
export const inspectorStore = createStore({
  context: {
    state: "idle" as InspectState,
    currentTarget: undefined as Omit<InspectedTarget, "id"> | undefined,
    inspectedTargets: [] as InspectedTarget[],
  },
  emits: {
    STARTED: () => {},
    STOPPED: () => {},
    TARGET_REMOVED: (_payload: { id: string }) => {},
    TARGETS_CLEARED: () => {},
  },
  on: {
    START: (context, _event, enqueue) => {
      enqueue.emit.STARTED();
      return {
        ...context,
        state: "active" as const,
      };
    },
    STOP: (_context, _event, enqueue) => {
      enqueue.emit.STOPPED();
      return {
        state: "idle" as const,
        currentTarget: undefined,
        inspectedTargets: [],
      };
    },
    POINTER_MOVE: (context, event: { event: PointerEvent }) => {
      if (context.state !== "active") return context;

      const current = tryInspectElement(event.event, context.inspectedTargets);
      if (!current) {
        if (!context.currentTarget) return context;
        return {
          ...context,
          currentTarget: undefined,
        };
      }

      return {
        ...context,
        currentTarget: {
          element: current.element,
          metadata: current.metadata,
        },
      };
    },
    POINTER_DOWN: (context, event: { event: PointerEvent }) => {
      if (context.state !== "active") return context;

      event.event.preventDefault();
      event.event.stopPropagation();
      event.event.stopImmediatePropagation();

      const currentTarget = context.currentTarget;
      if (!currentTarget) return context;

      if (context.inspectedTargets.some((target) => target.element === currentTarget.element))
        return context;

      const newTarget = {
        id: uuid(),
        ...currentTarget,
      };

      return {
        ...context,
        currentTarget: undefined,
        inspectedTargets: [...context.inspectedTargets, newTarget],
      };
    },
    POINTER_LEAVE: (context) => {
      if (context.state !== "active") return context;
      return {
        ...context,
        currentTarget: undefined,
      };
    },
    REMOVE_INSPECTED_TARGET: (context, event: { id: string }, enqueue) => {
      const nextTargets = context.inspectedTargets.filter((target) => target.id !== event.id);

      enqueue.emit.TARGET_REMOVED({ id: event.id });
      return {
        ...context,
        inspectedTargets: nextTargets,
      };
    },
    CLEAR_INSPECTED_TARGETS: (context, _event, enqueue) => {
      enqueue.emit.TARGETS_CLEARED();
      return {
        ...context,
        inspectedTargets: [],
      };
    },
    // This event is for RPC sync only - does NOT emit to prevent recursion
    SET_INSPECTED_TARGETS: (context, event: { targets: InspectedTarget[] }) => ({
      ...context,
      inspectedTargets: event.targets,
    }),
  },
});

/**
 * Inspector Store Simple - For parent/vibe side (without emit events)
 *
 * Simplified store that maintains local UI state independently from iframe's inspectorStore.
 * Uses InspectedTargetData (without DOM element references) since Host doesn't need them.
 * Supports optimistic updates on user actions and receives sync updates from iframe via RPC.
 */
export const inspectorStoreSync = createStore({
  context: {
    state: "idle" as InspectState,
    inspectedTargets: [] as InspectedTargetData[],
  },
  emits: {} as {
    STARTED: () => void;
    STOPPED: () => void;
    TARGET_REMOVED: (data: { id: string }) => void;
    TARGETS_CLEARED: () => void;
  },
  on: {
    START: (context, _, enq) => {
      enq.emit.STARTED();
      return {
        ...context,
        state: "active" as const,
      };
    },
    STOP: (context, _, enq) => {
      enq.emit.STOPPED();
      return {
        ...context,
        state: "idle" as const,
        inspectedTargets: [],
      };
    },
    REMOVE_INSPECTED_TARGET: (context, event: { id: string }, enq) => {
      enq.emit.TARGET_REMOVED({ id: event.id });
      return {
        ...context,
        inspectedTargets: context.inspectedTargets.filter((target) => target.id !== event.id),
      };
    },
    CLEAR_INSPECTED_TARGETS: (context, _, enq) => {
      enq.emit.TARGETS_CLEARED();
      return {
        ...context,
        inspectedTargets: [],
      };
    },
    // This event is for RPC sync only - does NOT emit to prevent recursion
    SET_INSPECTED_TARGETS: (context, event: { targets: InspectedTargetData[] }) => ({
      ...context,
      inspectedTargets: event.targets,
    }),
    // This event is for RPC sync only - does NOT emit to prevent recursion
    SET_INSPECTED_STATE: (context, event: { state: InspectState }) => ({
      ...context,
      state: event.state,
    }),
  },
});
