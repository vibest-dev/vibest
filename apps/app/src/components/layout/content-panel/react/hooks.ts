import { useMemo } from "react";
import { useStore } from "zustand";

import type { PanelPresentation, PanelSnapshot } from "../core/content-panel";
import type { PanelDefinition, PanelInstance, PayloadArgs } from "../core/panel";
import { useContentPanelContext } from "./context";
import type { AnyPanelView } from "./view";

/** Session-level operations, with the session already bound. Panel-level ones live on the instance. */
export interface ContentPanelSession {
  readonly sessionId: string;
  open<Type extends string, Payload, Extra extends object>(
    definition: PanelDefinition<Type, Payload, Extra, AnyPanelView>,
    ...payload: PayloadArgs<Payload>
  ): PanelInstance<Payload, Extra>;
  /** By type, for a "+" menu entry — the definition is the registry's business. */
  openNew(type: string): void;
  activate(id: string): void;
  close(id: string): void;
  setPresentation(presentation: PanelPresentation): void;
  toggleVisibility(): void;
}

/**
 * Zero subscriptions: the returned object is stable, so a component that only
 * opens panels never re-renders when the panel state moves. Reads of current
 * state happen inside the callbacks, through `getState`.
 *
 * null outside a session route.
 */
export function useContentPanel(): ContentPanelSession | null {
  const { contentPanel, sessionId } = useContentPanelContext();
  return useMemo(() => {
    if (sessionId === null) return null;
    return {
      sessionId,
      open: (definition, ...payload) => contentPanel.open(sessionId, definition, ...payload),
      openNew: (type) => contentPanel.openNew(sessionId, type),
      activate: (id) => contentPanel.activate(sessionId, id),
      close: (id) => contentPanel.close(sessionId, id),
      setPresentation: (presentation) => contentPanel.setPresentation(sessionId, presentation),
      toggleVisibility: () => contentPanel.toggleVisibility(sessionId),
    };
  }, [contentPanel, sessionId]);
}

/**
 * The one subscription entry point; granularity is the caller's to choose.
 * The selector must return something `Object.is`-stable — every field on the
 * snapshot is, so select fields rather than deriving new objects here, and
 * never select the snapshot itself.
 */
export function usePanelSnapshot<Selected>(
  selector: (snapshot: PanelSnapshot<AnyPanelView>) => Selected,
): Selected {
  const { contentPanel, sessionId } = useContentPanelContext();
  return useStore(contentPanel.store, (state) => selector(contentPanel.snapshot(state, sessionId)));
}
