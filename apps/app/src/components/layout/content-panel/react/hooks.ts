import { useMemo } from "react";
import { useStore } from "zustand";

import { sessionRefKey } from "@/lib/session-ref";

import type { PanelPresentation, PanelSnapshot } from "../model/content-panel";
import type { PanelDefinition, PanelInstance, PayloadArgs } from "../model/panel";
import { useContentPanelContext } from "./context";
import type { AnyPanelView } from "./view";

/** Session-level operations, with the session already bound. Panel-level ones live on the instance. */
export interface ContentPanelSession {
  readonly sessionKey: string;
  open<Type extends string, Payload, Extra extends object>(
    definition: PanelDefinition<Type, Payload, Extra, AnyPanelView>,
    ...payload: PayloadArgs<Payload>
  ): PanelInstance<Payload, Extra>;
  replace<Type extends string, Payload, Extra extends object>(
    currentId: string,
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
  const { contentPanel, sessionRef } = useContentPanelContext();
  return useMemo(() => {
    if (sessionRef === null) return null;
    return {
      sessionKey: sessionRefKey(sessionRef),
      open: (definition, ...payload) => contentPanel.open(sessionRef, definition, ...payload),
      replace: (currentId, definition, ...payload) =>
        contentPanel.replace(sessionRef, currentId, definition, ...payload),
      openNew: (type) => contentPanel.openNew(sessionRef, type),
      activate: (id) => contentPanel.activate(sessionRef, id),
      close: (id) => contentPanel.close(sessionRef, id),
      setPresentation: (presentation) => contentPanel.setPresentation(sessionRef, presentation),
      toggleVisibility: () => contentPanel.toggleVisibility(sessionRef),
    };
  }, [contentPanel, sessionRef]);
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
  const { contentPanel, sessionRef } = useContentPanelContext();
  return useStore(contentPanel.store, (state) =>
    selector(contentPanel.snapshot(state, sessionRef)),
  );
}
